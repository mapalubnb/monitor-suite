export function buildVaultFactoryLaunchUrl(factory, options = {}) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(factory || "")) || /^0x0{40}$/i.test(factory)) return "";
  const chain = options.chain === "robinhood" ? "robinhood" : "bnb";
  return `https://flap.sh/launch?vaultfactory=${factory}&chain=${chain}&lang=zh`;
}
