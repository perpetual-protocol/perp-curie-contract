export interface ContractNameAndDir {
    name: string
    dir: string
}

// only for slither analysis.
export const allDeployedContractsNamesAndDirs: ContractNameAndDir[] = [
    { name: "ClearingHouse.sol", dir: "./contracts" },
    { name: "AccountBalance.sol", dir: "./contracts" },
    { name: "Exchange.sol", dir: "./contracts" },
    { name: "Vault.sol", dir: "./contracts" },
    { name: "QuoteToken.sol", dir: "./contracts" },
    { name: "BaseToken.sol", dir: "./contracts" },
    { name: "ClearingHouseConfig.sol", dir: "./contracts" },
    { name: "InsuranceFund.sol", dir: "./contracts" },
    { name: "MarketRegistry.sol", dir: "./contracts" },
    { name: "OrderBook.sol", dir: "./contracts" },
    { name: "CollateralManager.sol", dir: "./contracts" },
    { name: "DelegateApproval.sol", dir: "./contracts" },
]
