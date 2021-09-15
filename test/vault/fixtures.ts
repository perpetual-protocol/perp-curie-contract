import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import {
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestERC20,
    UniswapV3Factory,
    Vault,
} from "../../typechain"

interface MockedVaultFixture {
    vault: Vault
    USDC: TestERC20
    mockedClearingHouse: MockContract
    mockedInsuranceFund: MockContract
}

interface VaultFixture {
    vault: Vault
    USDC: TestERC20
    clearingHouse: ClearingHouse
    insuranceFund: InsuranceFund
}

export async function mockedVaultFixture(): Promise<MockedVaultFixture> {
    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const USDC = (await tokenFactory.deploy()) as TestERC20
    await USDC.initialize("TestUSDC", "USDC")

    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy()) as Vault
    await vault.initialize(USDC.address)

    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
    const mockedInsuranceFund = await smockit(insuranceFund)
    mockedInsuranceFund.smocked.token.will.return.with(USDC.address)

    // deploy clearingHouse
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

    const marketRegistryFactory = await ethers.getContractFactory("MarketRegistry")
    const marketRegistry = (await marketRegistryFactory.deploy()) as MarketRegistry
    await marketRegistry.initialize(uniV3Factory.address, USDC.address)

    const orderBookFactory = await ethers.getContractFactory("OrderBook")
    const orderBook = (await orderBookFactory.deploy()) as OrderBook
    await orderBook.initialize(marketRegistry.address, USDC.address)

    const exchangeFactory = await ethers.getContractFactory("Exchange")
    const exchange = (await exchangeFactory.deploy()) as Exchange
    await exchange.initialize(marketRegistry.address, orderBook.address)
    await orderBook.setExchange(exchange.address)

    const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
    const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
    await clearingHouseConfig.initialize()

    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
    await clearingHouse.initialize(
        clearingHouseConfig.address,
        vault.address,
        insuranceFund.address,
        USDC.address,
        uniV3Factory.address,
        exchange.address,
    )
    const mockedClearingHouse = await smockit(clearingHouse)

    await vault.setInsuranceFund(mockedInsuranceFund.address)
    await vault.setClearingHouse(mockedClearingHouse.address)

    return { vault, USDC, mockedClearingHouse, mockedInsuranceFund }
}
