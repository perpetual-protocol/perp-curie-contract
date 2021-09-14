import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { BaseToken, ClearingHouse, ExchangeRegistry, UniswapV3Factory } from "../../typechain"
import { createBaseTokenFixture, createQuoteTokenFixture, token0Fixture, tokensFixture } from "../shared/fixtures"

interface MockedExchangeRegistryFixture {
    exchangeRegistry: ExchangeRegistry
    mockedQuoteToken: MockContract
    mockedClearingHouse: MockContract
    mockedUniV3Factory: MockContract
}

export async function mockedExchangeRegistryFixture(): Promise<MockedExchangeRegistryFixture> {
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
    const mockedClearingHouse = await smockit(clearingHouse)

    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockedUniV3Factory = await smockit(uniV3Factory)

    const quoteToken = await createQuoteTokenFixture("USD", "USD")()
    const mockedQuoteToken = await smockit(quoteToken)

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

    return {
        exchangeRegistry,
        mockedQuoteToken,
        mockedClearingHouse,
        mockedUniV3Factory,
    }
}
