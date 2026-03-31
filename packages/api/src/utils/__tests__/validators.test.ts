import * as validators from '../validators';

describe('validators', () => {
  describe('validatePassword', () => {
    it('should return true if password meets all complexity requirements', () => {
      expect(validators.validatePassword('Abcdefgh1234!')).toBe(true);
      expect(validators.validatePassword('MyP@ssw0rd12')).toBe(true);
    });

    it('should return false if password is empty or missing', () => {
      expect(validators.validatePassword(null!)).toBe(false);
      expect(validators.validatePassword(undefined!)).toBe(false);
      expect(validators.validatePassword('')).toBe(false);
    });

    it('should return false if password is too short', () => {
      expect(validators.validatePassword('Abc1!')).toBe(false);
      expect(validators.validatePassword('Abcdefg1!')).toBe(false);
    });

    it('should return false if password is too long', () => {
      expect(validators.validatePassword('A1!' + 'a'.repeat(62))).toBe(false);
    });

    it('should return false if password is missing uppercase', () => {
      expect(validators.validatePassword('abcdefgh1234!')).toBe(false);
    });

    it('should return false if password is missing lowercase', () => {
      expect(validators.validatePassword('ABCDEFGH1234!')).toBe(false);
    });

    it('should return false if password is missing a number', () => {
      expect(validators.validatePassword('Abcdefghijkl!')).toBe(false);
    });

    it('should return false if password is missing a special character', () => {
      expect(validators.validatePassword('Abcdefgh1234')).toBe(false);
    });
  });
});
