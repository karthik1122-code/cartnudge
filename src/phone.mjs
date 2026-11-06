// Normalises a phone number to WhatsApp's format: digits only, country code included, no "+".
// Indian 10-digit mobiles (and 0-prefixed ones) get 91. Returns null when it cannot be a mobile number.
export function normalizePhone(raw, defaultCountryCode = '91') {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) {
    if (defaultCountryCode === '91' && !/^[6-9]/.test(digits)) return null;
    digits = defaultCountryCode + digits;
  }
  if (digits.length < 11 || digits.length > 15) return null;
  if (digits.startsWith('91') && (digits.length !== 12 || !/^91[6-9]/.test(digits))) return null;
  return digits;
}

export function maskPhone(phone) {
  if (!phone) return '';
  return `+${phone.slice(0, 2)} ••••• ${phone.slice(-4)}`;
}
