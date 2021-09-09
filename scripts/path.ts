export interface ContractNameAndDir {
    name: string
    dir: string
}

// only for slither analysis.
export const allDeployedContractsNamesAndDirs: ContractNameAndDir[] = [
    { name: "ClearingHouse.sol", dir: "./contracts" },
    { name: "Exchange.sol", dir: "./contracts" },
    { name: "Vault.sol", dir: "./contracts" },
    { name: "QuoteToken.sol", dir: "./contracts" },
    { name: "BaseToken.sol", dir: "./contracts" },
]
