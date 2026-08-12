import type { FormEvent } from 'react';

/**
 * The `preventDefault` + `form.handleSubmit()` wrapper every settings dialog
 * form repeated inline. `useAppForm`'s `handleSubmit` takes no arguments, so
 * this is generic over nothing in particular — just the one call every
 * dialog's `<form onSubmit>` needs.
 */
export function submitFormEvent(handleSubmit: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handleSubmit();
  };
}
