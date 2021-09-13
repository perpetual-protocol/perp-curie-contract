import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { BaseToken, ClearingHouse, ExchangeRegistry, QuoteToken, UniswapV3Factory } from "../../typechain"

interface MockedExchangeRegistryFixture {
    exchangeRegistry: ExchangeRegistry
    mockedQuoteToken: MockContract
    mockedBaseToken: MockContract
    mockedClearingHouse: MockContract
    mockedUniV3Factory: MockContract
}

export async function mockedExchangeFixture(): Promise<MockedExchangeRegistryFixture> {
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
    const mockedClearingHouse = await smockit(clearingHouse)

    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockedUniV3Factory = await smockit(uniV3Factory)

    const quoteTokenFactory = await ethers.getContractFactory("QuoteToken")
    const quoteToken = (await quoteTokenFactory.deploy()) as QuoteToken
    const mockedQuoteToken = await smockit(quoteToken)

    const baseTokenFactory = await ethers.getContractFactory("BaseToken")
    const baseToken = (await baseTokenFactory.deploy()) as BaseToken
    const mockedBaseToken = await smockit(baseToken)

    const exchangeRegistryFactory = await ethers.getContractFactory("ExchangeRegistry")
    const exchangeRegistry = (await exchangeRegistryFactory.deploy()) as ExchangeRegistry
    await exchangeRegistry.initialize(mockedUniV3Factory.address, mockedQuoteToken.address, mockedClearingHouse.address)

    mockedQuoteToken.smocked.decimals.will.return.with(async () => {
        return 18
    })
    mockedQuoteToken.smocked.totalSupply.will.return.with(async () => {
        return ethers.constants.MaxUint256
    })
    mockedQuoteToken.smocked.isInWhitelist.will.return.with(async () => {
        return true
    })

    mockedBaseToken.smocked.decimals.will.return.with(async () => {
        return 18
    })
    mockedBaseToken.smocked.balanceOf.will.return.with(async () => {
        return ethers.constants.MaxUint256
    })
    mockedBaseToken.smocked.isInWhitelist.will.return.with(async () => {
        return true
    })

    return {
        exchangeRegistry,
        mockedQuoteToken,
        mockedBaseToken,
        mockedClearingHouse,
        mockedUniV3Factory,
    }
}
