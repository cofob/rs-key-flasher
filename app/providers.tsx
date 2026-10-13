"use client";

import { ToastProvider, ToastViewport } from "@cofob2/design-system-react/client";

export function AppProviders({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ToastProvider>
      {children}
      <ToastViewport position="bottom-right" />
    </ToastProvider>
  );
}
