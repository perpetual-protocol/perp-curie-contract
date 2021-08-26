export interface ContractNameAndDir {
    name: string
    dir: string
}

export const allDeployedContractsNamesAndDirs: ContractNameAndDir[] = [
    { name: "ClearingHouse.sol", dir: "./contracts" },
    { name: "Exchange.sol", dir: "./contracts" },
    { name: "Vault.sol", dir: "./contracts" },
    { name: "VirtualToken.sol", dir: "./contracts" },
]
