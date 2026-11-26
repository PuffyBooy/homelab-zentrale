import { createContext, useContext, useState, type ReactElement, type ReactNode } from 'react';
import { EnrollDialog } from './EnrollDialog.js';

const OpenEnroll = createContext<() => void>(() => undefined);

/**
 * Hosts the "Server hinzufügen" dialog in the shell, so it stays open while the page
 * below changes (the empty state turns into the list as soon as the agent connects).
 */
export function EnrollProvider({ children }: { children?: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <OpenEnroll.Provider value={() => setOpen(true)}>
      {children}
      <EnrollDialog open={open} onClose={() => setOpen(false)} />
    </OpenEnroll.Provider>
  );
}

export function useOpenEnroll(): () => void {
  return useContext(OpenEnroll);
}
