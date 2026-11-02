import { describe, expect, it } from 'vitest';
import { scan } from '../src/server/dlp';

describe('credentials written as plain English', () => {
  it.each([
    'my password is hunter22',
    'The password is: Tr0ub4dor&3',
    'the passcode was 8841',
    'verification code 493021',
    'Your verification code is 493021',
    'one-time code: 771204',
  ])('holds %s', (text) => {
    expect(scan(text)).not.toEqual([]);
  });

  it.each([
    'the password is required',
    'security code is 118',
    'What is your password?',
    'I forgot my password again',
    'Send me the verification code when you get it',
    'the code is on the fridge',
    'We meet at 7',
  ])('leaves %s alone', (text) => {
    expect(scan(text)).toEqual([]);
  });

  it('still holds Chinese passwords, since people can write in any language', () => {
    expect(scan('密码是 abc12345')).not.toEqual([]);
    expect(scan('验证码：493021')).not.toEqual([]);
    expect(scan('我忘了密码')).toEqual([]);
  });
});
