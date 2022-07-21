import { MockContract, smockit } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, ClearingHouseConfig, Exchange, UniswapV3Pool } from "../../typechain"
import { mockedClearingHouseFixture } from "./fixtures"

describe("ClearingHouse Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const DEFAULT_FEE = 3000

    let clearingHouse: ClearingHouse
    let clearingHouseConfig: ClearingHouseConfig
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract
    let exchange: Exchange
    let insuranceFund: MockContract
    let vault: MockContract
    let accountBalance: MockContract
    let marketRegistry: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(mockedClearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        clearingHouseConfig = _clearingHouseFixture.clearingHouseConfig
        baseToken = _clearingHouseFixture.mockedBaseToken
        quoteToken = _clearingHouseFixture.mockedQuoteToken
        uniV3Factory = _clearingHouseFixture.mockedUniV3Factory
        exchange = _clearingHouseFixture.exchange
        insuranceFund = _clearingHouseFixture.mockedInsuranceFund
        vault = _clearingHouseFixture.mockedVault
        accountBalance = _clearingHouseFixture.mockedAccountBalance
        marketRegistry = _clearingHouseFixture.mockedMarketRegistry

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        baseToken.smocked.getIndexPrice.will.return.with(parseEther("100"))
    })

    describe("# initialize", () => {
        it("force error, invalid vault address", async () => {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await expect(
                clearingHouse.initialize(
                    clearingHouseConfig.address,
                    wallet.address,
                    quoteToken.address,
                    uniV3Factory.address,
                    exchange.address,
                    accountBalance.address,
                    insuranceFund.address,
                ),
            ).to.be.revertedWith("CH_VANC")
        })

        it("force error, invalid quote token address", async () => {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await expect(
                clearingHouse.initialize(
                    clearingHouseConfig.address,
                    vault.address,
                    wallet.address,
                    uniV3Factory.address,
                    exchange.address,
                    accountBalance.address,
                    insuranceFund.address,
                ),
            ).to.be.revertedWith("CH_QANC")
        })

        it("force error, invalid uniV3Factory address", async () => {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await expect(
                clearingHouse.initialize(
                    clearingHouseConfig.address,
                    vault.address,
                    quoteToken.address,
                    wallet.address,
                    exchange.address,
                    accountBalance.address,
                    insuranceFund.address,
                ),
            ).to.be.revertedWith("CH_UANC")
        })
    })

    describe("onlyOwner setters", () => {
        it("setMaxTickCrossedWithinBlock", async () => {
            marketRegistry.smocked.getPool.will.return.with(EMPTY_ADDRESS)
            await expect(exchange.setMaxTickCrossedWithinBlock(baseToken.address, 200)).to.be.revertedWith("EX_BTNE")

            // add pool
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            marketRegistry.smocked.hasPool.will.return.with(true)

            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 200)
            expect(await exchange.getMaxTickCrossedWithinBlock(baseToken.address)).eq(200)

            // out of range [0, 2 * 887272]
            // MIN_TICK = -887272
            // MAX_TICK = 887272
            await expect(exchange.setMaxTickCrossedWithinBlock(baseToken.address, 2 * 887272 + 1)).to.be.revertedWith(
                "EX_MTCLOOR",
            )
        })

        it("force error, invalid base token address when setMaxTickCrossedWithinBlock", async () => {
            await expect(exchange.setMaxTickCrossedWithinBlock(wallet.address, 1)).to.be.revertedWith("EX_BNC")
        })

        // it("force error, invalid trustedForwarder address when setTrustedForwarder", async () => {
        //     await expect(clearingHouse.setTrustedForwarder(wallet.address)).to.be.revertedWith("CH_TFNC")
        // })
    })

    describe("# getRequiredCollateral", () => {})
})
