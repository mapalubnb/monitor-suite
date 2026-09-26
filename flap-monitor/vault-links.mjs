export function buildVaultFactoryLaunchUrl(factory) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(factory || "")) || /^0x0{40}$/i.test(factory)) return "";
  return `https://flap.sh/launch?vaultfactory=${factory}&chain=bnb&lang=zh`;
}
