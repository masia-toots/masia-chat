/**
 * The plain browser speaker: the other person's voice on one `<audio>` element (`srcObject` = the call's stream). The
 * default for a host with no audio output of its own; a host that arbitrates sound between several players (a radio, an
 * assistant's voice) gives its own `CallSpeaker` instead, one that also reports when other media took the output over
 * (`onInterrupted`).
 *
 * A browser that will not start playback without a gesture makes `attach` answer false; the engine then says
 * `speaker-blocked` and the screen offers the tap that calls `resumeSpeaker()`.
 */
import type { CallSpeaker } from './call-engine.js';

export function createAudioElementSpeaker(): CallSpeaker {
  let element: HTMLAudioElement | null = null;
  const ensure = (): HTMLAudioElement => {
    if (element) return element;
    const created = new Audio();
    created.autoplay = false;
    element = created;
    return created;
  };
  const play = async (): Promise<boolean> => {
    try {
      await ensure().play();
      return true;
    } catch {
      return false;
    }
  };
  return {
    attach(stream) {
      ensure().srcObject = stream;
      return play();
    },
    resume: play,
    detach() {
      if (!element) return;
      element.pause();
      element.srcObject = null;
    },
    dispose() {
      if (!element) return;
      element.pause();
      element.srcObject = null;
      element = null;
    },
  };
}
