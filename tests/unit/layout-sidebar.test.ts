/** Hotfix: the sidebar keeps its width in every section (Caja compressed it: its tab bar set the page's minimum width). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');

describe('layout — stable sidebar', () => {
  it('the sidebar never shrinks and the content takes only the remaining width', () => {
    const app = SRC('App.tsx');
    expect(app).toMatch(/className=\{`bg-\[#2C2419\] text-white flex flex-col shrink-0 /);
    expect(app).toMatch(/sidebarOpen \? 'w-64' : 'w-0'/);            // same width, same mobile toggle
    expect(app).toMatch(/className=\{`flex-1 min-w-0 min-h-screen flex flex-col /);
  });
  it('Caja handles its own horizontal overflow (the tab bar scrolls inside it)', () => {
    const caja = SRC('features/caja/CajaApp.tsx');
    expect(caja).toMatch(/className="w-full max-w-6xl min-w-0 /);
    expect(caja).toMatch(/<nav className="flex gap-2 mt-4 overflow-x-auto">/);
  });
});
