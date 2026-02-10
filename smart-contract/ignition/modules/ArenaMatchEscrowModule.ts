import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("ArenaMatchEscrowModule", (m) => {
  const escrow = m.contract("ArenaMatchEscrow");

  return { escrow };
});
