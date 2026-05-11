import React, { useState, useEffect } from 'react';
import { Settings, Sun, Moon, Monitor, Type, AlignJustify, Rows3, ChevronRight, Check } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

const FONT_OPTIONS = [
  { label: 'Inter', value: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" },
  { label: 'Charter', value: "'Charter', serif" },
  { label: 'Monospace', value: "'Geist Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace" },
  { label: 'System Sans', value: '-apple-system, BlinkMacSystemFont, sans-serif' },
  { label: 'Open Sans', value: "'Open Sans', -apple-system, BlinkMacSystemFont, sans-serif" },
];

const FONT_SIZE_OPTIONS = [
  { label: 'Small', value: 13 },
  { label: 'Normal', value: 16 },
  { label: 'Large', value: 19 },
  { label: 'Extra Large', value: 22 },
];

const LINE_HEIGHT_OPTIONS = [
  { label: 'Compact', value: 1.4 },
  { label: 'Normal', value: 1.8 },
  { label: 'Relaxed', value: 2.2 },
];

const PARA_SPACING_OPTIONS = [
  { label: 'None', value: 0 },
  { label: 'Small', value: 0.3 },
  { label: 'Normal', value: 0.6 },
  { label: 'Large', value: 1.5 },
];

function readLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function nearestOption(options, value) {
  let best = options[0].value;
  let bestDiff = Infinity;
  for (const o of options) {
    const diff = Math.abs(o.value - value);
    if (diff < bestDiff) { bestDiff = diff; best = o.value; }
  }
  return best;
}

export function SettingsMenu() {
  const [theme, setTheme] = useState(() => readLS('gull-theme', 'light'));
  const [style, setStyle] = useState(() => {
    const saved = readLS('gull-reading-style', {});
    return {
      fontFamily: saved.fontFamily ?? "'Charter', serif",
      fontSize: saved.fontSize ?? 16,
      lineHeight: saved.lineHeight ?? 1.8,
      paraSpacing: saved.paraSpacing ?? 0.6,
    };
  });

  useEffect(() => {
    const handler = (e) => setTheme(e.detail);
    window.addEventListener('gull-theme-changed', handler);
    return () => window.removeEventListener('gull-theme-changed', handler);
  }, []);

  function applyTheme(value) {
    const resolved = value === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : value;
    setTheme(value);
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem('gull-theme', value);
    window.settings?.set('theme', resolved);
  }

  function updateStyle(patch) {
    const next = { ...style, ...patch };
    setStyle(next);
    localStorage.setItem('gull-reading-style', JSON.stringify(next));
    const root = document.documentElement;
    root.style.setProperty('--book-font-family', next.fontFamily);
    root.style.setProperty('--book-font-size', next.fontSize + 'px');
    root.style.setProperty('--book-line-height', String(next.lineHeight));
    root.style.setProperty('--book-para-spacing', next.paraSpacing + 'em');
  }

  const themeIcon = theme === 'dark' ? <Moon size={14} /> : theme === 'system' ? <Monitor size={14} /> : <Sun size={14} />;
  const fontSize = nearestOption(FONT_SIZE_OPTIONS, style.fontSize);
  const lineHeight = nearestOption(LINE_HEIGHT_OPTIONS, style.lineHeight);
  const paraSpacing = nearestOption(PARA_SPACING_OPTIONS, style.paraSpacing);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button id="btn-settings" aria-label="Settings">
          <Settings size={15} aria-hidden="true" />
          Settings
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="sm-content" side="top" align="start" sideOffset={8}>

          {/* Theme */}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="sm-item sm-sub-trigger">
              <span className="sm-icon">{themeIcon}</span>
              Switch theme
              <ChevronRight size={12} className="sm-arrow" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="sm-content" sideOffset={4}>
                <DropdownMenu.RadioGroup value={theme} onValueChange={applyTheme}>
                  <RadioItem value="system" icon={<Monitor size={14} />}>System</RadioItem>
                  <RadioItem value="light" icon={<Sun size={14} />}>Light</RadioItem>
                  <RadioItem value="dark" icon={<Moon size={14} />}>Dark</RadioItem>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Separator className="sm-separator" />

          {/* Font family */}
          <SubMenu icon={<Type size={14} />} label="Font">
            <DropdownMenu.RadioGroup value={style.fontFamily} onValueChange={(v) => updateStyle({ fontFamily: v })}>
              {FONT_OPTIONS.map((o) => (
                <RadioItem key={o.value} value={o.value}>{o.label}</RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </SubMenu>

          {/* Font size */}
          <SubMenu icon={<span className="sm-aa">Aa</span>} label="Font Size">
            <DropdownMenu.RadioGroup
              value={String(fontSize)}
              onValueChange={(v) => updateStyle({ fontSize: Number(v) })}
            >
              {FONT_SIZE_OPTIONS.map((o) => (
                <RadioItem key={o.value} value={String(o.value)}>{o.label}</RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </SubMenu>

          {/* Line height */}
          <SubMenu icon={<Rows3 size={14} />} label="Line Height">
            <DropdownMenu.RadioGroup
              value={String(lineHeight)}
              onValueChange={(v) => updateStyle({ lineHeight: Number(v) })}
            >
              {LINE_HEIGHT_OPTIONS.map((o) => (
                <RadioItem key={o.value} value={String(o.value)}>{o.label}</RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </SubMenu>

          {/* Paragraph spacing */}
          <SubMenu icon={<AlignJustify size={14} />} label="Paragraphs">
            <DropdownMenu.RadioGroup
              value={String(paraSpacing)}
              onValueChange={(v) => updateStyle({ paraSpacing: Number(v) })}
            >
              {PARA_SPACING_OPTIONS.map((o) => (
                <RadioItem key={o.value} value={String(o.value)}>{o.label}</RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </SubMenu>

        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SubMenu({ icon, label, children }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="sm-item sm-sub-trigger">
        <span className="sm-icon">{icon}</span>
        {label}
        <ChevronRight size={12} className="sm-arrow" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className="sm-content" sideOffset={4}>
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function RadioItem({ value, icon, children }) {
  return (
    <DropdownMenu.RadioItem className="sm-item sm-radio-item" value={value}>
      <DropdownMenu.ItemIndicator className="sm-radio-indicator">
        <Check size={12} />
      </DropdownMenu.ItemIndicator>
      {icon && <span className="sm-icon">{icon}</span>}
      {children}
    </DropdownMenu.RadioItem>
  );
}
