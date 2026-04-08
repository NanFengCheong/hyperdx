/**
 * HyperDX Logomark
 * Uses the favicon.png image
 */
export default function Logomark({ size = 16 }: { size?: number }) {
  return (
    <img
      src="/favicon.png"
      alt="HyperDX Logo"
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}
