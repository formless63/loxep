import { useThemeConfig } from '@/components/themes/active-theme';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';

import { Icons } from '../icons';
import { Kbd } from '@/components/ui/kbd';
import { THEMES } from './theme.config';

export function ThemeSelector() {
  const { activeTheme, setActiveTheme } = useThemeConfig();

  return (
    <div className='flex items-center gap-2'>
      <Label htmlFor='theme-selector' className='sr-only'>
        Theme
      </Label>
      <Select value={activeTheme} onValueChange={(value) => setActiveTheme(value)}>
        <SelectTrigger
          id='theme-selector'
          className='justify-start *:data-[slot=select-value]:w-24'
        >
          <span className='text-muted-foreground hidden sm:block'>
            <Icons.palette />
          </span>
          <span className='text-muted-foreground block sm:hidden'>Theme</span>
          <SelectValue placeholder='Select a theme' />
          <Kbd>T T</Kbd>
        </SelectTrigger>
        {/*
          `position='popper'` on purpose. The shared default is Radix's
          `item-aligned` mode, which opens the list anchored so the SELECTED
          item sits over the trigger — with a long theme list under a trigger
          near the top of the viewport, every theme above the selected one
          ends up scrolled out of sight, and Radix hides the viewport
          scrollbar, so nothing hints they exist. Popper mode opens the list
          below the trigger from the top instead; the height is bounded to the
          available space, the viewport height override defeats the shared
          popper class that would otherwise pin it to the trigger's height,
          and a thin scrollbar is restored so it reads as scrollable.
        */}
        <SelectContent
          align='end'
          position='popper'
          sideOffset={4}
          className='max-h-[min(20rem,var(--radix-select-content-available-height))] [&_[data-radix-select-viewport]]:h-auto [&_[data-radix-select-viewport]]:max-h-[min(19rem,var(--radix-select-content-available-height))] [&_[data-radix-select-viewport]]:overflow-y-auto [&_[data-radix-select-viewport]]:[scrollbar-width:thin]'
        >
          {THEMES.length > 0 && (
            <>
              <SelectGroup>
                <SelectLabel>themes</SelectLabel>
                {THEMES.map((theme) => (
                  <SelectItem key={theme.name} value={theme.value}>
                    {theme.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
