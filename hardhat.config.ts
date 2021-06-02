import "@nomiclabs/hardhat-waffle";
import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-ethers";
import "solidity-coverage";
import "@typechain/hardhat";

const config: HardhatUserConfig = {
  solidity: "0.7.6",
};

export default config;
