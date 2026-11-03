// Types for the Vite import forms the bench uses (Vite is not a dependency of this package).
declare module '*?worker&url' {
  const url: string;
  export default url;
}
declare module '*.css';
