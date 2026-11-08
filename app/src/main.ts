import { mount } from 'svelte';
// Self-hosted fonts (spec §2): COEP blocks cross-origin fonts without CORP,
// so they are bundled rather than loaded from a font CDN. Inter is the UI
// face (variable weight); JetBrains Mono is every number and readout.
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
// Tokens and native-control skins; see docs/architecture/ui-theme.md.
import './ui/theme.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
