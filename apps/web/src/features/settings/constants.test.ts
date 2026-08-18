/**
 * The browser-side notification mirror must not drift from the domain
 * registry (audit 2026-08-18).
 *
 * `constants.ts` cannot import `@loxep/domain`'s registry as a VALUE — the
 * barrel re-exports server-only code — so it hand-mirrors the class→types
 * map, and `satisfies Record<NotificationEventClass, readonly string[]>`
 * does not catch a class left empty: `[]` satisfies `readonly string[]`.
 * That is exactly how `infrastructure: []` survived long after all four of
 * its event types started emitting, silently removing the class from the
 * rule dialog so no operator could route a DNS-drift or reconcile-failure
 * alert anywhere.
 *
 * This test imports the registry directly (a test file is not the browser
 * bundle) and asserts the mirror matches it type-for-type, and that every
 * mirrored type has an operator-facing label.
 */
import { describe, expect, test } from 'bun:test';
import { notificationEventClasses } from '@loxep/domain';
import { notificationEventTypeOptionsFor, notificationEventClassOptions } from './constants';

describe('notification class/type mirror', () => {
  const wiredClasses = Object.values(notificationEventClasses).filter(
    (definition) => definition.wired
  );

  test('every wired class is offered as a rule class', () => {
    const offered = new Set(notificationEventClassOptions.map((option) => option.value));
    for (const definition of wiredClasses) {
      expect(offered.has(definition.eventClass)).toBe(true);
    }
  });

  test('each wired class offers exactly the registry’s event types', () => {
    for (const definition of wiredClasses) {
      const mirrored = notificationEventTypeOptionsFor(definition.eventClass).map(
        (option) => option.value
      );
      expect(mirrored.toSorted()).toEqual([...definition.eventTypes].toSorted());
    }
  });

  test('every offered type carries a human label, never a raw enum value', () => {
    for (const definition of wiredClasses) {
      for (const option of notificationEventTypeOptionsFor(definition.eventClass)) {
        expect(option.label.length).toBeGreaterThan(0);
        expect(option.label).not.toBe(option.value);
      }
    }
  });
});
