export const validatePassword = (password: string) => {
  if (!password || password.length < 12 || password.length > 64) {
    return false;
  }
  // Must include both lower and upper case
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return false;
  }
  // Must include at least one number
  if (!/\d/.test(password)) {
    return false;
  }
  // Must include at least one special character (any non-alphanumeric)
  if (!/\W/.test(password)) {
    return false;
  }
  return true;
};
