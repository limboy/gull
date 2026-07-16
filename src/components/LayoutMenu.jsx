import React, { useState, useEffect } from 'react';
import { CaseSensitive, Check } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

export function LayoutMenu() {
  const initialSettings = window.initialSettings || {};
  const [chapterScrollbar, setChapterScrollbar] = useState(initialSettings.chapterScrollbar !== false);
  const [fullWidth, setFullWidth] = useState(initialSettings.fullWidth === true);

  useEffect(() => {
    const sbHandler = (enabled) => setChapterScrollbar(enabled);
    window.settings?.onChapterScrollbarChanged(sbHandler);

    const settingsHandler = (settings) => {
      if (settings) {
        if (typeof settings.chapterScrollbar !== 'undefined') {
          setChapterScrollbar(settings.chapterScrollbar !== false);
        }
        if (typeof settings.fullWidth !== 'undefined') {
          setFullWidth(settings.fullWidth === true);
        }
      }
    };
    window.settings?.onSettingsChanged(settingsHandler);
  }, []);

  function toggleChapterScrollbar(checked) {
    setChapterScrollbar(checked);
    window.settings?.set('chapterScrollbar', checked);
  }

  function toggleFullWidth(checked) {
    setFullWidth(checked);
    window.settings?.set('fullWidth', checked);
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button id="btn-layout-settings" title="Layout Settings" aria-label="Layout Settings">
          <CaseSensitive size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="sm-content layout-menu-content" side="bottom" align="end" sideOffset={8}>
          {/* Chapter Scrollbar */}
          <DropdownMenu.CheckboxItem
            className="sm-item sm-checkbox-item"
            checked={chapterScrollbar}
            onCheckedChange={toggleChapterScrollbar}
          >
            <DropdownMenu.ItemIndicator className="sm-radio-indicator">
              <Check size={12} />
            </DropdownMenu.ItemIndicator>
            Chapter scrollbar
          </DropdownMenu.CheckboxItem>

          {/* Full Width */}
          <DropdownMenu.CheckboxItem
            className="sm-item sm-checkbox-item"
            checked={fullWidth}
            onCheckedChange={toggleFullWidth}
          >
            <DropdownMenu.ItemIndicator className="sm-radio-indicator">
              <Check size={12} />
            </DropdownMenu.ItemIndicator>
            Full width
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
