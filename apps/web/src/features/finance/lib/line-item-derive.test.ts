import { describe, expect, test } from 'bun:test';
import {
  divideMicros,
  EMPTY_LINE_ITEM_DERIVE_STATE,
  lineItemDeriveStateFromValues,
  multiplyMicros,
  setLineItemField,
  type LineItemDeriveState
} from './line-item-derive';

describe('multiplyMicros / divideMicros', () => {
  test('multiplies two exact decimals', () => {
    expect(multiplyMicros('2', '5.00')).toBe('10.000000');
    expect(multiplyMicros('2.5', '4')).toBe('10.000000');
  });

  test('rounds a multiply result half-up at 6dp', () => {
    // 0.000001 * 0.5 = 0.0000005 exactly — the true product needs a 7th
    // decimal digit that is exactly half a unit at 6dp, so it rounds up.
    expect(multiplyMicros('0.000001', '0.5')).toBe('0.000001');
  });

  test('divides two exact decimals', () => {
    expect(divideMicros('10', '2')).toBe('5.000000');
    expect(divideMicros('10.000000', '4')).toBe('2.500000');
  });

  test('rounds a divide result half-up at 6dp', () => {
    // 1 / 3 = 0.333333... -> rounds to 0.333333 (not up, remainder < half)
    expect(divideMicros('1', '3')).toBe('0.333333');
    // 2 / 3 = 0.666666... -> rounds to 0.666667
    expect(divideMicros('2', '3')).toBe('0.666667');
  });

  test('guards divide-by-zero by returning null, never Infinity/NaN', () => {
    expect(divideMicros('10', '0')).toBeNull();
    expect(divideMicros('10', '0.000000')).toBeNull();
  });

  test('returns null for a non-decimal input on either operation', () => {
    expect(multiplyMicros('abc', '2')).toBeNull();
    expect(multiplyMicros('2', '')).toBeNull();
    expect(divideMicros('abc', '2')).toBeNull();
    expect(divideMicros('2', '')).toBeNull();
  });

  test('handles negative operands (a discount/coupon line)', () => {
    expect(multiplyMicros('-2', '5')).toBe('-10.000000');
    expect(divideMicros('-10', '4')).toBe('-2.500000');
    expect(divideMicros('10', '-4')).toBe('-2.500000');
  });
});

describe('setLineItemField — fill-two-derive-third state machine', () => {
  test('typing only one field derives nothing', () => {
    const next = setLineItemField(EMPTY_LINE_ITEM_DERIVE_STATE, 'quantity', '2');
    expect(next.quantity).toEqual({ value: '2', owner: 'user' });
    expect(next.unitPrice).toEqual({ value: '', owner: 'empty' });
    expect(next.subtotal).toEqual({ value: '', owner: 'empty' });
  });

  test('qty + unitPrice derives subtotal = qty * unitPrice', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '3');
    state = setLineItemField(state, 'unitPrice', '4.50');
    expect(state.subtotal).toEqual({ value: '13.500000', owner: 'derived' });
    expect(state.quantity.owner).toBe('user');
    expect(state.unitPrice.owner).toBe('user');
  });

  test('qty + subtotal derives unitPrice = subtotal / qty', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '4');
    state = setLineItemField(state, 'subtotal', '10');
    expect(state.unitPrice).toEqual({ value: '2.500000', owner: 'derived' });
  });

  test('unitPrice + subtotal derives qty = subtotal / unitPrice', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'unitPrice', '5');
    state = setLineItemField(state, 'subtotal', '17.50');
    expect(state.quantity).toEqual({ value: '3.500000', owner: 'derived' });
  });

  test('a zero quantity guards the unitPrice derivation instead of dividing by zero', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '0');
    state = setLineItemField(state, 'subtotal', '10');
    expect(state.unitPrice).toEqual({ value: '', owner: 'empty' });
  });

  test('a zero unitPrice guards the quantity derivation instead of dividing by zero', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'unitPrice', '0');
    state = setLineItemField(state, 'subtotal', '10');
    expect(state.quantity).toEqual({ value: '', owner: 'empty' });
  });

  test('editing a user-owned field recomputes the derived field only', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '2');
    state = setLineItemField(state, 'unitPrice', '5');
    expect(state.subtotal).toEqual({ value: '10.000000', owner: 'derived' });

    state = setLineItemField(state, 'quantity', '3');
    expect(state.subtotal).toEqual({ value: '15.000000', owner: 'derived' });
    // The field the operator typed stays user-owned, exactly as typed.
    expect(state.quantity).toEqual({ value: '3', owner: 'user' });
    expect(state.unitPrice).toEqual({ value: '5', owner: 'user' });
  });

  test('directly editing the derived field takes ownership of it and stops recomputation', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '2');
    state = setLineItemField(state, 'unitPrice', '5');
    expect(state.subtotal.owner).toBe('derived');

    state = setLineItemField(state, 'subtotal', '20');
    expect(state.subtotal).toEqual({ value: '20', owner: 'user' });
    // All three are now user-owned; a further edit to any one of them must
    // NOT silently overwrite either of the other two, since only one field
    // may ever be 'empty'/'derived' at a time for auto-computation to run.
    state = setLineItemField(state, 'quantity', '4');
    expect(state.unitPrice).toEqual({ value: '5', owner: 'user' });
    expect(state.subtotal).toEqual({ value: '20', owner: 'user' });
  });

  test('clearing one of the two owning fields resets a stale derived field to empty', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '2');
    state = setLineItemField(state, 'unitPrice', '5');
    expect(state.subtotal.owner).toBe('derived');

    state = setLineItemField(state, 'quantity', '');
    expect(state.quantity).toEqual({ value: '', owner: 'empty' });
    expect(state.subtotal).toEqual({ value: '', owner: 'empty' });
    expect(state.unitPrice).toEqual({ value: '5', owner: 'user' });
  });

  test('clearing a user field that leaves two OTHER fields owned re-derives a different third', () => {
    // qty + subtotal owned (unitPrice derived) -> clear subtotal -> unitPrice
    // resets to empty since only qty remains owned.
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '4');
    state = setLineItemField(state, 'subtotal', '10');
    expect(state.unitPrice).toEqual({ value: '2.500000', owner: 'derived' });

    state = setLineItemField(state, 'subtotal', '');
    expect(state.subtotal).toEqual({ value: '', owner: 'empty' });
    expect(state.unitPrice).toEqual({ value: '', owner: 'empty' });
    expect(state.quantity).toEqual({ value: '4', owner: 'user' });
  });

  test('re-deriving after taking ownership: clearing the now-user subtotal field lets it become derived again', () => {
    let state = EMPTY_LINE_ITEM_DERIVE_STATE;
    state = setLineItemField(state, 'quantity', '2');
    state = setLineItemField(state, 'unitPrice', '5');
    state = setLineItemField(state, 'subtotal', '999'); // operator overrides
    expect(state.subtotal).toEqual({ value: '999', owner: 'user' });

    state = setLineItemField(state, 'subtotal', '');
    expect(state.subtotal).toEqual({ value: '10.000000', owner: 'derived' });
  });

  test('all combinations of which two fields are filled derive the correct third (exhaustive)', () => {
    const cases: Array<{
      first: [keyof LineItemDeriveState, string];
      second: [keyof LineItemDeriveState, string];
      expectDerivedKey: keyof LineItemDeriveState;
      expectDerivedValue: string;
    }> = [
      {
        first: ['quantity', '2'],
        second: ['unitPrice', '3'],
        expectDerivedKey: 'subtotal',
        expectDerivedValue: '6.000000'
      },
      {
        first: ['unitPrice', '3'],
        second: ['quantity', '2'],
        expectDerivedKey: 'subtotal',
        expectDerivedValue: '6.000000'
      },
      {
        first: ['quantity', '2'],
        second: ['subtotal', '6'],
        expectDerivedKey: 'unitPrice',
        expectDerivedValue: '3.000000'
      },
      {
        first: ['subtotal', '6'],
        second: ['quantity', '2'],
        expectDerivedKey: 'unitPrice',
        expectDerivedValue: '3.000000'
      },
      {
        first: ['unitPrice', '3'],
        second: ['subtotal', '6'],
        expectDerivedKey: 'quantity',
        expectDerivedValue: '2.000000'
      },
      {
        first: ['subtotal', '6'],
        second: ['unitPrice', '3'],
        expectDerivedKey: 'quantity',
        expectDerivedValue: '2.000000'
      }
    ];

    for (const testCase of cases) {
      let state = EMPTY_LINE_ITEM_DERIVE_STATE;
      state = setLineItemField(state, testCase.first[0], testCase.first[1]);
      state = setLineItemField(state, testCase.second[0], testCase.second[1]);
      expect(state[testCase.expectDerivedKey]).toEqual({
        value: testCase.expectDerivedValue,
        owner: 'derived'
      });
    }
  });
});

describe('lineItemDeriveStateFromValues', () => {
  test('hydrates non-empty values as user-owned with no derivation run', () => {
    const state = lineItemDeriveStateFromValues({
      quantity: '2',
      unitPrice: '5',
      subtotal: '999' // deliberately inconsistent with 2 * 5 — hydration never recomputes
    });
    expect(state.quantity).toEqual({ value: '2', owner: 'user' });
    expect(state.unitPrice).toEqual({ value: '5', owner: 'user' });
    expect(state.subtotal).toEqual({ value: '999', owner: 'user' });
  });

  test('hydrates empty strings as the empty field', () => {
    const state = lineItemDeriveStateFromValues({ quantity: '', unitPrice: '', subtotal: '' });
    expect(state).toEqual(EMPTY_LINE_ITEM_DERIVE_STATE);
  });
});
