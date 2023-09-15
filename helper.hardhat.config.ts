export const HARDHAT_CHAINID = 31337
export const GOERLI_CHAINID = 5

interface ContractArguments {
    name: string
    usdc?: string
    veth?: string
    ethusdPriceFeed?: string
}
interface ConfigHelper {
    [chainId: number]: ContractArguments
}

export const networkConfigHelper: ConfigHelper = {
    5: {
        name: "goerli",
        usdc: "",
        ethusdPriceFeed: "",
    },
    10: {
        name: "optimism mainnet",
        usdc: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
        ethusdPriceFeed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
    },
    420: {
        name: "Optimism Goerli Testnet",
        usdc: "0x5f1C3c9D42F531975EdB397fD4a34754cc8D3b71",
        ethusdPriceFeed: "0x57241A37733983F97C4Ab06448F244A1E0Ca0ba8",
    },
    31337: {
        name: "hardhat",
        usdc: "",
        ethusdPriceFeed: "",
        veth: "",
    },
}

export const isDevelopmentChain = (chainId: number) => {
    const developmentNetworkNames = ["hardhat", "localhost"]
    return developmentNetworkNames.includes(networkConfigHelper[chainId]?.name)
}
