import { describe, expect, it } from 'vitest';

import { getPhoneNumberFormatted } from '../../src/helpers/formatHelper';

describe('getPhoneNumberFormatted', () => {
  it('should remove all non-numeric characters from the phone number', () => {
    const input = '(123) 456-7890';
    const expectedOutput = '1234567890';
    expect(getPhoneNumberFormatted(input)).toBe(expectedOutput);
  });

  it('should return the same string if it already contains only numeric characters', () => {
    const input = '9876543210';
    const expectedOutput = '9876543210';
    expect(getPhoneNumberFormatted(input)).toBe(expectedOutput);
  });

  it('should handle an empty string and return an empty string', () => {
    const input = '';
    const expectedOutput = '';
    expect(getPhoneNumberFormatted(input)).toBe(expectedOutput);
  });

  it('should remove special characters and spaces', () => {
    const input = '+1 (800) 123-4567 ext. 89';
    const expectedOutput = '1800123456789';
    expect(getPhoneNumberFormatted(input)).toBe(expectedOutput);
  });

  it('should handle strings with only non-numeric characters and return an empty string', () => {
    const input = 'abcdefg';
    const expectedOutput = '';
    expect(getPhoneNumberFormatted(input)).toBe(expectedOutput);
  });
});
