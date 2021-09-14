import { MockContract, smockit } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers, waffle } from "hardhat"
import { BaseToken, ExchangeRegistry, UniswapV3Pool } from "../../typechain"
import { mockedExchangeRegistryFixture } from "./fixtures"
import { token0Fixture } from "../shared/fixtures"

describe("ExchangeRegistry Spec", () => {
    const [wallet, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const DEFAULT_FEE = 3000

    let exchangeRegistry: ExchangeRegistry
    let baseToken: BaseToken
    let quoteToken: MockContract
    let uniV3Factory: MockContract

    beforeEach(async () => {
        const _exchangeFixtures = await loadFixture(mockedExchangeRegistryFixture)
        exchangeRegistry = _exchangeFixtures.exchangeRegistry
        quoteToken = _exchangeFixtures.mockedQuoteToken
        uniV3Factory = _exchangeFixtures.mockedUniV3Factory

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        // deploy baseToken
        const token0FixtureResults = await token0Fixture(quoteToken.address)
        const clearingHouseAddr = _exchangeFixtures.mockedClearingHouse.address
        token0FixtureResults.mockedAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [parseEther("100")]
        })
        baseToken = token0FixtureResults.baseToken
        await baseToken.mintMaximumTo(clearingHouseAddr)
        await baseToken.addWhitelist(clearingHouseAddr)
    })

    describe("# addPool", () => {
        let poolFactory
        let pool
        let mockedPool
        beforeEach(async () => {
            poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            await baseToken.addWhitelist(mockedPool.address)
        })

        describe("after the pool is initialized", () => {
            beforeEach(async () => {
                mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            })

            // @SAMPLE - addPool
            it("add a UniswapV3 pool and send an event", async () => {
                // check event has been sent
                await expect(exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE))
                    .to.emit(exchangeRegistry, "PoolAdded")
                    .withArgs(baseToken.address, DEFAULT_FEE, mockedPool.address)

                expect(await exchangeRegistry.getPool(baseToken.address)).to.eq(mockedPool.address)
            })
        })
    })

    describe("onlyOwner setters", () => {
        beforeEach(async () => {
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            await baseToken.addWhitelist(mockedPool.address)
        })

        describe("after addPool", () => {
            beforeEach(async () => {
                await exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE)
            })

            it("setFeeRatio", async () => {
                await exchangeRegistry.setFeeRatio(baseToken.address, 10000) // 1%
                expect(await exchangeRegistry.getFeeRatio(baseToken.address)).eq(10000)
            })

            it("force error, ratio overflow", async () => {
                const twoHundredPercent = 2000000 // 200% in uint24
                await expect(exchangeRegistry.setFeeRatio(baseToken.address, twoHundredPercent)).to.be.revertedWith(
                    "EX_RO",
                )
            })

            it("setInsuranceFundFeeRatio", async () => {
                await exchangeRegistry.setInsuranceFundFeeRatio(baseToken.address, 10000) // 1%
                expect(await exchangeRegistry.getInsuranceFundFeeRatio(baseToken.address)).eq(10000)
            })

            it("force error, ratio overflow", async () => {
                const twoHundredPercent = 2000000 // 200% in uint24
                await expect(exchangeRegistry.setFeeRatio(baseToken.address, twoHundredPercent)).to.be.revertedWith(
                    "EX_RO",
                )
            })

            it("force error, ratio overflow", async () => {
                const twoHundredPercent = 2000000 // 200% in uint24
                await expect(
                    exchangeRegistry.setInsuranceFundFeeRatio(baseToken.address, twoHundredPercent),
                ).to.be.revertedWith("EX_RO")
            })

            it("force error, caller not owner", async () => {
                await expect(exchangeRegistry.connect(alice).setFeeRatio(baseToken.address, 10000)).to.be.revertedWith(
                    "SO_CNO",
                )
                await expect(
                    exchangeRegistry.connect(alice).setInsuranceFundFeeRatio(baseToken.address, 10000),
                ).to.be.revertedWith("SO_CNO")
                await expect(exchangeRegistry.connect(alice).setMaxOrdersPerMarket(1)).to.be.revertedWith("SO_CNO")
            })
        })

        it("force error, pool not exists", async () => {
            await expect(exchangeRegistry.setFeeRatio(baseToken.address, 10000)).to.be.revertedWith("EX_PNE")
            await expect(exchangeRegistry.setInsuranceFundFeeRatio(baseToken.address, 10000)).to.be.revertedWith(
                "EX_PNE",
            )
        })

        it("setMaxOrdersPerMarket", async () => {
            await exchangeRegistry.setMaxOrdersPerMarket(1)
            expect(await exchangeRegistry.maxOrdersPerMarket()).eq(1)
        })
    })
})
