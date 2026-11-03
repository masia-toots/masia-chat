//! `openmls-peer`: a JSON-lines driver around OpenMLS for the messenger's interop test.
//!
//! Protocol: one JSON object per line on stdin (`{"id":1,"cmd":"...", ...}`), one JSON object per
//! line on stdout (`{"id":1,"ok":true,"result":{...}}` or `{"id":1,"ok":false,"error":"..."}`).
//! Every byte string travels as standard base64. The error text is the `Debug` form of OpenMLS's
//! own error, so a refusal is recorded exactly as the library words it.
//!
//! The process holds many named CLIENTS (each with its own provider, storage and signature key), so
//! one container can play a whole room of OpenMLS devices. There is no network and no disk state.
//!
//! Every commit this peer makes is merged at once: the harness plays a relay that accepts it.

use std::collections::HashMap;
use std::io::{BufRead, Write};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use openmls::prelude::tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde_json::{json, Value};

type R<T> = Result<T, String>;

fn dbg<E: std::fmt::Debug>(error: E) -> String {
    format!("{error:?}")
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn unb64(req: &Value, key: &str) -> R<Vec<u8>> {
    let text = req
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field `{key}`"))?;
    STANDARD
        .decode(text)
        .map_err(|e| format!("field `{key}` is not base64: {e}"))
}

fn opt_unb64(req: &Value, key: &str) -> R<Option<Vec<u8>>> {
    match req.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => unb64(req, key).map(Some),
    }
}

fn text<'a>(req: &'a Value, key: &str) -> R<&'a str> {
    req.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field `{key}`"))
}

fn flag(req: &Value, key: &str, default: bool) -> bool {
    req.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn u16_list(req: &Value, key: &str) -> R<Option<Vec<u16>>> {
    match req.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .ok_or_else(|| format!("`{key}` must hold u16 numbers"))
            })
            .collect::<R<Vec<u16>>>()
            .map(Some),
        Some(_) => Err(format!("`{key}` must be an array")),
    }
}

/// An extension spec from the harness: `{"type": 61889, "data": "<base64>"}`.
fn unknown_extensions(req: &Value, key: &str) -> R<Vec<(u16, Vec<u8>)>> {
    let mut out = Vec::new();
    if let Some(Value::Array(items)) = req.get(key) {
        for item in items {
            let ext_type = item
                .get("type")
                .and_then(Value::as_u64)
                .and_then(|n| u16::try_from(n).ok())
                .ok_or("extension `type` must be a u16")?;
            let data = unb64(item, "data")?;
            out.push((ext_type, data));
        }
    }
    Ok(out)
}

struct Client {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    ciphersuite: Ciphersuite,
    /// Keyed by the base64 of the MLS group id.
    groups: HashMap<String, MlsGroup>,
}

#[derive(Default)]
struct Peer {
    clients: HashMap<String, Client>,
}

fn wire_policy(req: &Value) -> R<WireFormatPolicy> {
    match req.get("wire_format").and_then(Value::as_str).unwrap_or("ciphertext") {
        "ciphertext" => Ok(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY),
        "plaintext" => Ok(PURE_PLAINTEXT_WIRE_FORMAT_POLICY),
        "mixed-ciphertext" => Ok(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY),
        "mixed-plaintext" => Ok(MIXED_PLAINTEXT_WIRE_FORMAT_POLICY),
        other => Err(format!("unknown wire_format `{other}`")),
    }
}

/// The leaf capabilities of a device. The default is the one the messenger asks for: MLS 1.0, every
/// suite OpenMLS speaks, the basic credential and OUR group-context extension type. The harness can
/// override the extension list (to build a leaf that does NOT list ours) or add GREASE.
fn capabilities(req: &Value, ciphersuite: Ciphersuite, provider: &OpenMlsRustCrypto) -> R<Capabilities> {
    let extensions: Vec<ExtensionType> = u16_list(req, "capability_extensions")?
        .unwrap_or_else(|| vec![0xf0c1])
        .into_iter()
        .map(ExtensionType::from)
        .collect();
    let suites: Vec<Ciphersuite> = match u16_list(req, "capability_ciphersuites")? {
        Some(ids) => ids
            .into_iter()
            .map(|id| Ciphersuite::try_from(id).map_err(dbg))
            .collect::<R<Vec<_>>>()?,
        None => vec![ciphersuite],
    };
    let mut caps = Capabilities::builder()
        .ciphersuites(suites)
        .extensions(extensions)
        .build();
    if flag(req, "grease", false) {
        caps = caps.with_grease(provider.rand());
    }
    Ok(caps)
}

fn extensions_of<T>(list: Vec<(u16, Vec<u8>)>) -> R<Extensions<T>>
where
    T: ExtensionValidator,
    InvalidExtensionError: From<T::Error>,
{
    let mut extensions = Extensions::<T>::default();
    for (ext_type, data) in list {
        extensions
            .add(Extension::Unknown(ext_type, UnknownExtension(data)))
            .map_err(dbg)?;
    }
    Ok(extensions)
}

impl Peer {
    fn client(&mut self, req: &Value) -> R<&mut Client> {
        let name = text(req, "client")?.to_string();
        self.clients
            .get_mut(&name)
            .ok_or_else(|| format!("no client named `{name}`"))
    }

    fn handle(&mut self, req: &Value) -> R<Value> {
        match text(req, "cmd")? {
            "hello" => Ok(json!({
                "peer": env!("CARGO_PKG_NAME"),
                "peerVersion": env!("CARGO_PKG_VERSION"),
            })),
            "new_client" => self.new_client(req),
            "key_package" => self.key_package(req),
            "create_group" => self.create_group(req),
            "join" => self.join(req),
            "add" => self.add(req),
            "remove" => self.remove(req),
            "self_update" => self.self_update(req),
            "propose_add" => self.propose_add(req),
            "commit_pending" => self.commit_pending(req),
            "propose_gce" => self.propose_gce(req),
            "export_group_info" => self.export_group_info(req),
            "external_join" => self.external_join(req),
            "process" => self.process(req),
            "encrypt" => self.encrypt(req),
            "state" => self.state(req),
            "export_secret" => self.export_secret(req),
            "forget" => self.forget(req),
            "ratchet_tree" => self.ratchet_tree(req),
            other => Err(format!("unknown command `{other}`")),
        }
    }

    fn new_client(&mut self, req: &Value) -> R<Value> {
        let name = text(req, "client")?.to_string();
        let identity = unb64(req, "identity")?;
        let suite_id = req.get("ciphersuite").and_then(Value::as_u64).unwrap_or(1);
        let ciphersuite = Ciphersuite::try_from(u16::try_from(suite_id).map_err(dbg)?).map_err(dbg)?;
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(ciphersuite.signature_algorithm()).map_err(dbg)?;
        signer.store(provider.storage()).map_err(dbg)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity).into(),
            signature_key: signer.to_public_vec().into(),
        };
        let public = signer.to_public_vec();
        self.clients.insert(
            name,
            Client { provider, signer, credential, ciphersuite, groups: HashMap::new() },
        );
        Ok(json!({ "signaturePublicKey": b64(&public) }))
    }

    fn key_package(&mut self, req: &Value) -> R<Value> {
        let client = self.client(req)?;
        let caps = capabilities(req, client.ciphersuite, &client.provider)?;
        let mut builder = KeyPackage::builder().leaf_node_capabilities(caps);
        let leaf_extensions = unknown_extensions(req, "leaf_extensions")?;
        if !leaf_extensions.is_empty() {
            builder = builder.leaf_node_extensions(extensions_of::<LeafNode>(leaf_extensions)?);
        }
        if let Some(seconds) = req.get("lifetime_seconds").and_then(Value::as_u64) {
            builder = builder.key_package_lifetime(Lifetime::new(seconds));
        }
        let bundle = builder
            .build(client.ciphersuite, &client.provider, &client.signer, client.credential.clone())
            .map_err(dbg)?;
        let key_package = bundle.key_package().clone();
        let lifetime = key_package.life_time();
        let bytes = MlsMessageOut::from(key_package.clone()).to_bytes().map_err(dbg)?;
        Ok(json!({
            "keyPackage": b64(&bytes),
            "notBefore": lifetime.not_before(),
            "notAfter": lifetime.not_after(),
        }))
    }

    fn join_config(req: &Value) -> R<MlsGroupJoinConfig> {
        Ok(MlsGroupJoinConfig::builder()
            .wire_format_policy(wire_policy(req)?)
            .use_ratchet_tree_extension(flag(req, "ratchet_tree_extension", true))
            .padding_size(req.get("padding").and_then(Value::as_u64).unwrap_or(0) as usize)
            .build())
    }

    fn create_group(&mut self, req: &Value) -> R<Value> {
        let client = self.client(req)?;
        let caps = capabilities(req, client.ciphersuite, &client.provider)?;
        let gc = extensions_of::<GroupContext>(unknown_extensions(req, "gc_extensions")?)?;
        let mut builder = MlsGroupCreateConfig::builder()
            .ciphersuite(client.ciphersuite)
            .wire_format_policy(wire_policy(req)?)
            .use_ratchet_tree_extension(flag(req, "ratchet_tree_extension", true))
            .padding_size(req.get("padding").and_then(Value::as_u64).unwrap_or(0) as usize)
            .capabilities(caps)
            .with_group_context_extensions(gc);
        let leaf_extensions = unknown_extensions(req, "leaf_extensions")?;
        if !leaf_extensions.is_empty() {
            builder = builder
                .with_leaf_node_extensions(extensions_of::<LeafNode>(leaf_extensions)?)
                .map_err(dbg)?;
        }
        let config = builder.build();
        let group_id = GroupId::from_slice(&unb64(req, "group_id")?);
        let group = MlsGroup::new_with_group_id(
            &client.provider,
            &client.signer,
            &config,
            group_id.clone(),
            client.credential.clone(),
        )
        .map_err(dbg)?;
        let summary = summarize(client, &group);
        client.groups.insert(b64(group_id.as_slice()), group);
        Ok(summary)
    }

    fn join(&mut self, req: &Value) -> R<Value> {
        let welcome_bytes = unb64(req, "welcome")?;
        let tree = match opt_unb64(req, "ratchet_tree")? {
            Some(bytes) => Some(RatchetTreeIn::tls_deserialize_exact(bytes.as_slice()).map_err(dbg)?),
            None => None,
        };
        let config = Peer::join_config(req)?;
        let client = self.client(req)?;
        let welcome = match MlsMessageIn::tls_deserialize_exact(welcome_bytes.as_slice())
            .map_err(dbg)?
            .extract()
        {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err("the message is not a Welcome".to_string()),
        };
        let staged = StagedWelcome::new_from_welcome(&client.provider, &config, welcome, tree)
            .map_err(dbg)?;
        let group = staged.into_group(&client.provider).map_err(dbg)?;
        let summary = summarize(client, &group);
        client.groups.insert(b64(group.group_id().as_slice()), group);
        Ok(summary)
    }

    /// The commit the harness's relay accepted: merge it, then hand back the wire messages.
    fn merged(client: &mut Client, key: &str, bundle: CommitMessageBundle) -> R<Value> {
        let commit = bundle.commit().to_bytes().map_err(dbg)?;
        let welcome = match bundle.to_welcome_msg() {
            Some(message) => Some(b64(&message.to_bytes().map_err(dbg)?)),
            None => None,
        };
        let group = client.groups.get_mut(key).ok_or("unknown group")?;
        group.merge_pending_commit(&client.provider).map_err(dbg)?;
        let mut summary = summarize(client, client.groups.get(key).ok_or("unknown group")?);
        summary["commit"] = json!(b64(&commit));
        summary["welcome"] = json!(welcome);
        Ok(summary)
    }

    fn add(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let force_path = flag(req, "force_path", false);
        let client = self.client(req)?;
        let mut key_packages = Vec::new();
        for item in req.get("key_packages").and_then(Value::as_array).ok_or("missing `key_packages`")? {
            let bytes = STANDARD.decode(item.as_str().ok_or("key package must be base64")?).map_err(dbg)?;
            key_packages.push(parse_key_package(client, &bytes)?);
        }
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        let bundle = group
            .commit_builder()
            .propose_adds(key_packages)
            .force_self_update(force_path)
            .load_psks(client.provider.storage())
            .map_err(dbg)?
            .build(client.provider.rand(), client.provider.crypto(), &client.signer, |_| true)
            .map_err(dbg)?
            .stage_commit(&client.provider)
            .map_err(dbg)?;
        Peer::merged(client, &key, bundle)
    }

    fn remove(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let indexes: Vec<LeafNodeIndex> = u16_list(req, "leaf_indexes")?
            .ok_or("missing `leaf_indexes`")?
            .into_iter()
            .map(|i| LeafNodeIndex::new(u32::from(i)))
            .collect();
        let client = self.client(req)?;
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        let bundle = group
            .commit_builder()
            .propose_removals(indexes)
            .load_psks(client.provider.storage())
            .map_err(dbg)?
            .build(client.provider.rand(), client.provider.crypto(), &client.signer, |_| true)
            .map_err(dbg)?
            .stage_commit(&client.provider)
            .map_err(dbg)?;
        Peer::merged(client, &key, bundle)
    }

    fn self_update(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let client = self.client(req)?;
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        let bundle = group
            .self_update(&client.provider, &client.signer, LeafNodeParameters::default())
            .map_err(dbg)?;
        Peer::merged(client, &key, bundle)
    }

    /// A standalone Add proposal (sent by reference later). Not merged, not committed.
    fn propose_add(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let bytes = unb64(req, "key_package")?;
        let client = self.client(req)?;
        let key_package = parse_key_package(client, &bytes)?;
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        let (message, _reference) = group
            .propose_add_member(&client.provider, &client.signer, &key_package)
            .map_err(dbg)?;
        Ok(json!({ "proposal": b64(&message.to_bytes().map_err(dbg)?) }))
    }

    /// Commits whatever the proposal store holds: the proposals ride in the commit BY REFERENCE.
    fn commit_pending(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let client = self.client(req)?;
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        let bundle = group
            .commit_builder()
            .load_psks(client.provider.storage())
            .map_err(dbg)?
            .build(client.provider.rand(), client.provider.crypto(), &client.signer, |_| true)
            .map_err(dbg)?
            .stage_commit(&client.provider)
            .map_err(dbg)?;
        Peer::merged(client, &key, bundle)
    }

    /// A commit that carries a GroupContextExtensions proposal by value (RFC 9420 §12.1.7).
    fn propose_gce(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let list = unknown_extensions(req, "gc_extensions")?;
        let client = self.client(req)?;
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        let bundle = group
            .commit_builder()
            .propose_group_context_extensions(extensions_of::<GroupContext>(list)?)
            .map_err(dbg)?
            .load_psks(client.provider.storage())
            .map_err(dbg)?
            .build(client.provider.rand(), client.provider.crypto(), &client.signer, |_| true)
            .map_err(dbg)?
            .stage_commit(&client.provider)
            .map_err(dbg)?;
        Peer::merged(client, &key, bundle)
    }

    fn export_group_info(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let with_tree = flag(req, "with_ratchet_tree", true);
        let client = self.client(req)?;
        let group = client.groups.get(&key).ok_or("unknown group")?;
        let message = group
            .export_group_info(client.provider.crypto(), &client.signer, with_tree)
            .map_err(dbg)?;
        Ok(json!({ "groupInfo": b64(&message.to_bytes().map_err(dbg)?) }))
    }

    /// An EXTERNAL commit (RFC 9420 §12.4.3.2): a new device joins from a GroupInfo, no Add, no Welcome.
    fn external_join(&mut self, req: &Value) -> R<Value> {
        let bytes = unb64(req, "group_info")?;
        let config = Peer::join_config(req)?;
        let client = self.client(req)?;
        let group_info = match MlsMessageIn::tls_deserialize_exact(bytes.as_slice())
            .map_err(dbg)?
            .extract()
        {
            MlsMessageBodyIn::GroupInfo(group_info) => group_info,
            _ => return Err("the message is not a GroupInfo".to_string()),
        };
        // The joiner's leaf has to list the group's extension types, as every leaf does.
        let caps = capabilities(req, group_info.ciphersuite(), &client.provider)?;
        let leaf = LeafNodeParameters::builder().with_capabilities(caps).build();
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(config)
            .build_group(&client.provider, group_info, client.credential.clone())
            .map_err(dbg)?
            .leaf_node_parameters(leaf)
            .load_psks(client.provider.storage())
            .map_err(dbg)?
            .build(client.provider.rand(), client.provider.crypto(), &client.signer, |_| true)
            .map_err(dbg)?
            .finalize(&client.provider)
            .map_err(dbg)?;
        let commit = bundle.commit().to_bytes().map_err(dbg)?;
        let key = b64(group.group_id().as_slice());
        client.groups.insert(key.clone(), group);
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        group.merge_pending_commit(&client.provider).map_err(dbg)?;
        let mut summary = summarize(client, client.groups.get(&key).ok_or("unknown group")?);
        summary["commit"] = json!(b64(&commit));
        Ok(summary)
    }

    fn process(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let bytes = unb64(req, "message")?;
        let client = self.client(req)?;
        let protocol_message = MlsMessageIn::tls_deserialize_exact(bytes.as_slice())
            .map_err(dbg)?
            .try_into_protocol_message()
            .map_err(dbg)?;
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        let processed = group.process_message(&client.provider, protocol_message).map_err(dbg)?;
        let aad = processed.aad().to_vec();
        let sender = match processed.sender() {
            Sender::Member(index) => json!({ "type": "member", "leafIndex": index.u32() }),
            Sender::External(_) => json!({ "type": "external" }),
            Sender::NewMemberProposal => json!({ "type": "new_member_proposal" }),
            Sender::NewMemberCommit => json!({ "type": "new_member_commit" }),
        };
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => Ok(json!({
                "kind": "application",
                "plaintext": b64(&application.into_bytes()),
                "aad": b64(&aad),
                "sender": sender,
            })),
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                let facts = json!({
                    "kind": "commit",
                    "hasUpdatePath": staged.update_path_leaf_node().is_some(),
                    "adds": staged.add_proposals().count(),
                    "removes": staged.remove_proposals().count(),
                    "updates": staged.update_proposals().count(),
                    "proposals": staged.queued_proposals().count(),
                    "selfRemoved": staged.self_removed(),
                    "sender": sender,
                });
                group.merge_staged_commit(&client.provider, *staged).map_err(dbg)?;
                let mut summary = summarize(client, client.groups.get(&key).ok_or("unknown group")?);
                for (name, value) in facts.as_object().into_iter().flatten() {
                    summary[name] = value.clone();
                }
                Ok(summary)
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                group
                    .store_pending_proposal(client.provider.storage(), *proposal)
                    .map_err(dbg)?;
                Ok(json!({ "kind": "proposal", "sender": sender }))
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(_) => {
                Ok(json!({ "kind": "external_join_proposal", "sender": sender }))
            }
            ProcessedMessageContent::OwnPendingCommit => {
                Ok(json!({ "kind": "own_pending_commit", "sender": sender }))
            }
            ProcessedMessageContent::OwnPrivateMessage => {
                Ok(json!({ "kind": "own_private_message", "sender": sender }))
            }
        }
    }

    fn encrypt(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let plaintext = unb64(req, "plaintext")?;
        let aad = opt_unb64(req, "aad")?.unwrap_or_default();
        let client = self.client(req)?;
        let group = client.groups.get_mut(&key).ok_or("unknown group")?;
        // Set before EVERY message, empty included: the group keeps the last value.
        group.set_aad(aad);
        let message = group
            .create_message(&client.provider, &client.signer, &plaintext)
            .map_err(dbg)?;
        Ok(json!({ "ciphertext": b64(&message.to_bytes().map_err(dbg)?) }))
    }

    fn state(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let client = self.client(req)?;
        let group = client.groups.get(&key).ok_or("unknown group")?;
        Ok(summarize(client, group))
    }

    /// The ratchet tree as this client holds it (TLS-encoded): for diagnosing a refused Welcome.
    fn ratchet_tree(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let client = self.client(req)?;
        let group = client.groups.get(&key).ok_or("unknown group")?;
        let bytes = group.export_ratchet_tree().tls_serialize_detached().map_err(dbg)?;
        Ok(json!({ "ratchetTree": b64(&bytes) }))
    }

    /// What an application does with the state of a group it was removed from: delete it. A device
    /// that is added again (a fresh KeyPackage, same group) cannot join while the old state exists.
    fn forget(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let client = self.client(req)?;
        if let Some(mut group) = client.groups.remove(&key) {
            group.delete(client.provider.storage()).map_err(dbg)?;
        }
        Ok(json!({ "forgotten": true }))
    }

    fn export_secret(&mut self, req: &Value) -> R<Value> {
        let key = text(req, "group")?.to_string();
        let label = text(req, "label")?.to_string();
        let context = opt_unb64(req, "context")?.unwrap_or_default();
        let length = req.get("length").and_then(Value::as_u64).unwrap_or(32) as usize;
        let client = self.client(req)?;
        let group = client.groups.get(&key).ok_or("unknown group")?;
        let secret = group
            .export_secret(client.provider.crypto(), &label, &context, length)
            .map_err(dbg)?;
        Ok(json!({ "secret": b64(&secret) }))
    }
}

fn parse_key_package(client: &Client, bytes: &[u8]) -> R<KeyPackage> {
    match MlsMessageIn::tls_deserialize_exact(bytes).map_err(dbg)?.extract() {
        MlsMessageBodyIn::KeyPackage(key_package) => key_package
            .validate(client.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(dbg),
        _ => Err("the message is not a KeyPackage".to_string()),
    }
}

/// What the harness compares across implementations after every step.
fn summarize(client: &Client, group: &MlsGroup) -> Value {
    let members: Vec<Value> = group
        .members()
        .map(|member| {
            json!({
                "leafIndex": member.index.u32(),
                "identity": b64(member.credential.serialized_content()),
                "signatureKey": b64(&member.signature_key),
            })
        })
        .collect();
    let extensions: Vec<Value> = group
        .extensions()
        .iter()
        .map(|extension| json!({ "type": u16::from(extension.extension_type()) }))
        .collect();
    json!({
        "client": b64(client.signer.to_public_vec().as_slice()),
        "groupId": b64(group.group_id().as_slice()),
        "epoch": group.epoch().as_u64(),
        "epochAuthenticator": b64(group.epoch_authenticator().as_slice()),
        "active": group.is_active(),
        "ownLeafIndex": group.own_leaf_index().u32(),
        "members": members,
        "groupContextExtensions": extensions,
    })
}

fn main() {
    let mut peer = Peer::default();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let _ = writeln!(stdout, "{}", json!({ "id": null, "ok": false, "error": format!("bad json: {error}") }));
                let _ = stdout.flush();
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        // A panic inside the library must not kill the container silently: report it as an error.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| peer.handle(&request)))
            .unwrap_or_else(|panic| {
                let message = panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "panic".to_string());
                Err(format!("PANIC: {message}"))
            });
        let response = match outcome {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        };
        let _ = writeln!(stdout, "{response}");
        let _ = stdout.flush();
    }
}
