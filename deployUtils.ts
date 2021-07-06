import path from "path"

export enum ContractFullyQualifiedName {
    ClearingHouse = "contracts/ClearingHouse.sol:ClearingHouse",
    BaseToken = "contracts/BaseToken.sol:BaseToken",

    // external interface
    UniswapV3Factory = "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol:IUniswapV3Factory",
    IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",

    // used in tests
    TestERC20 = "contracts/test/TestERC20.sol:TestERC20",
}

export enum DeploymentsKey {
    ClearingHouse = "ClearingHouse",
    vUSD = "vUSD",
    vETH = "vETH",

    // external
    USDC = "USDC",
    UniswapV3Factory = "UniswapV3Factory",
}

export const DEPLOYMENT_CONTRACT_FILES = {
    [DeploymentsKey.ClearingHouse]: ContractFullyQualifiedName.ClearingHouse,
    [DeploymentsKey.vUSD]: ContractFullyQualifiedName.TestERC20,
    [DeploymentsKey.vETH]: ContractFullyQualifiedName.BaseToken,
}

// eg. extract "deploy/01-deploy-USDC.ts" -> 01
export function getDeployNonce(fullPath: string): string {
    const basename = path.basename(fullPath)
    const end = basename.indexOf("-")
    return basename.substr(0, end)
}
