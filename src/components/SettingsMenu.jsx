import React, { useEffect, useRef, useState } from 'react';
import { Settings2, Type, AlignJustify, Rows3, ChevronRight, Check } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  normalizePdfView,
  PDF_VIEW_STORAGE_KEY,
  PDF_ZOOM_OPTIONS,
} from '@/lib/pdf-view.mjs';

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
  const initialSettings = window.initialSettings || {};
  const [chapterScrollbar, setChapterScrollbar] = useState(initialSettings.chapterScrollbar !== false);
  // Typography does nothing to a fixed-layout PDF, so the menu swaps those
  // controls for page zoom while one is open. The runtime announces which kind
  // of book is on screen.
  const [bookKind, setBookKind] = useState(() => window.gullBookKind || null);
  const [pdfView, setPdfView] = useState(() => normalizePdfView(readLS(PDF_VIEW_STORAGE_KEY, null)));
  const openedByPointer = useRef(false);
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
    const onBookKind = (event) => setBookKind(event.detail?.kind || null);
    window.addEventListener('gull:book-kind', onBookKind);
    return () => window.removeEventListener('gull:book-kind', onBookKind);
  }, []);

  useEffect(() => {
    const unsubscribeScrollbar = window.settings?.onChapterScrollbarChanged((enabled) => {
      setChapterScrollbar(enabled !== false);
    });
    const unsubscribeSettings = window.settings?.onSettingsChanged((settings) => {
      if (typeof settings?.chapterScrollbar !== 'undefined') {
        setChapterScrollbar(settings.chapterScrollbar !== false);
      }
    });

    return () => {
      unsubscribeScrollbar?.();
      unsubscribeSettings?.();
    };
  }, []);

  function toggleChapterScrollbar(checked) {
    setChapterScrollbar(checked);
    window.settings?.set('chapterScrollbar', checked).catch((error) => {
      console.warn('Failed to save chapter scrollbar setting', error);
    });
  }

  function updatePdfView(patch) {
    const next = normalizePdfView({ ...pdfView, ...patch });
    setPdfView(next);
    localStorage.setItem(PDF_VIEW_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('gull:pdf-view-changed', { detail: next }));
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

  const isPdf = bookKind === 'pdf';
  const fontSize = nearestOption(FONT_SIZE_OPTIONS, style.fontSize);
  const lineHeight = nearestOption(LINE_HEIGHT_OPTIONS, style.lineHeight);
  const paraSpacing = nearestOption(PARA_SPACING_OPTIONS, style.paraSpacing);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          id="btn-settings"
          type="button"
          title="Settings"
          aria-label="Settings"
          onPointerDown={() => { openedByPointer.current = true; }}
          onKeyDown={() => { openedByPointer.current = false; }}
        >
          <Settings2 size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="sm-content"
          side="bottom"
          align="end"
          sideOffset={8}
          onCloseAutoFocus={(event) => {
            if (openedByPointer.current) event.preventDefault();
          }}
        >
          <CheckboxItem checked={chapterScrollbar} onCheckedChange={toggleChapterScrollbar}>
            Chapter scrollbar
          </CheckboxItem>

          <DropdownMenu.Separator className="sm-separator" />

          {isPdf ? (
            /* Page zoom — the only layout control a fixed-layout PDF has */
            <DropdownMenu.RadioGroup
              value={String(pdfView.zoom)}
              onValueChange={(v) => updatePdfView({ zoom: /^[\d.]+$/.test(v) ? Number(v) : v })}
            >
              {PDF_ZOOM_OPTIONS.map((o) => (
                <RadioItem key={String(o.value)} value={String(o.value)}>{o.label}</RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          ) : (
          <>
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
          </>
          )}

        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function CheckboxItem({ checked, onCheckedChange, children }) {
  return (
    <DropdownMenu.CheckboxItem
      className="sm-item sm-checkbox-item"
      checked={checked}
      onCheckedChange={onCheckedChange}
    >
      <DropdownMenu.ItemIndicator className="sm-radio-indicator">
        <Check size={12} />
      </DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.CheckboxItem>
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
