import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"

const config: HardhatUserConfig = {
    solidity: "0.7.6",
    external: {
        contracts: [
            {
                artifacts: "node_modules/@uniswap/v3-core/artifacts",
            },
        ],
    },
}

export default config
