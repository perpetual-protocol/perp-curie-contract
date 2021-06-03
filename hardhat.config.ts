import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"

const config: HardhatUserConfig = {
    solidity: "0.7.3",
}

export default config
