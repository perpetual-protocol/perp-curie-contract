import { MockContract, smockit } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers, waffle } from "hardhat"
import { BaseToken, MarketRegistry, UniswapV3Pool } from "../../typechain"
import { ADDR_GREATER_THAN, ADDR_LESS_THAN, mockedBaseTokenTo } from "../clearingHouse/fixtures"
import { token0Fixture } from "../shared/fixtures"
import { mockedMarketRegistryFixture } from "./fixtures"

describe("MarketRegistry Spec", () => {
    const [wallet, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000B"
    const DEFAULT_FEE = 3000

    let marketRegistry: MarketRegistry
    let baseToken: BaseToken
    let mockedQuoteToken: MockContract
    let mockedUniV3Factory: MockContract
    let mockedPool: MockContract
    let mockedClearingHouse: MockContract
    let poolFactory

    beforeEach(async () => {
        const _marketRegistryFixture = await loadFixture(mockedMarketRegistryFixture)
        marketRegistry = _marketRegistryFixture.marketRegistry
        mockedQuoteToken = _marketRegistryFixture.mockedQuoteToken
        mockedUniV3Factory = _marketRegistryFixture.mockedUniV3Factory
        mockedClearingHouse = _marketRegistryFixture.mockedClearingHouse

        poolFactory = await ethers.getContractFactory("UniswapV3Pool")
        const poolInstance = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
        mockedPool = await smockit(poolInstance)
        mockedPool.smocked.slot0.will.return.with([0, 0, 0, 0, 0, 0, false])
        mockedUniV3Factory.smocked.getPool.will.return.with(mockedPool.address)

        // deploy baseToken
        const token0FixtureResults = await token0Fixture(mockedQuoteToken.address)
        const clearingHouseAddr = _marketRegistryFixture.mockedClearingHouse.address
        token0FixtureResults.mockedAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [parseEther("100")]
        })
        baseToken = token0FixtureResults.baseToken
        await baseToken.mintMaximumTo(clearingHouseAddr)
        await baseToken.addWhitelist(clearingHouseAddr)
    })

    describe("# addPool", () => {
        beforeEach(async () => {
            await baseToken.addWhitelist(mockedPool.address)
            await marketRegistry.setClearingHouse(mockedClearingHouse.address)
        })

        it("force error, before the pool is initialized", async () => {
            await expect(marketRegistry.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("MR_PNI")
        })

        describe("after the pool is initialized", () => {
            beforeEach(async () => {
                mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            })

            // @SAMPLE - addPool
            it("add a UniswapV3 pool and send an event", async () => {
                // check event has been sent
                await expect(marketRegistry.addPool(baseToken.address, DEFAULT_FEE))
                    .to.emit(marketRegistry, "PoolAdded")
                    .withArgs(baseToken.address, DEFAULT_FEE, mockedPool.address)

                expect(await marketRegistry.getPool(baseToken.address)).to.eq(mockedPool.address)
            })

            it("add multiple UniswapV3 pools", async () => {
                await marketRegistry.addPool(baseToken.address, DEFAULT_FEE)
                expect(await marketRegistry.getPool(baseToken.address)).to.eq(mockedPool.address)

                const baseToken2 = await mockedBaseTokenTo(ADDR_LESS_THAN, mockedQuoteToken.address)
                baseToken2.smocked.balanceOf.will.return.with(ethers.constants.MaxUint256)
                baseToken2.smocked.isInWhitelist.will.return.with(true)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                mockedUniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await marketRegistry.addPool(baseToken2.address, DEFAULT_FEE)
                // verify isPoolExisted
                expect(await marketRegistry.getPool(baseToken2.address)).to.eq(mockedPool2.address)
            })

            it("force error, pool is not existent in uniswap v3", async () => {
                mockedUniV3Factory.smocked.getPool.will.return.with(() => {
                    return EMPTY_ADDRESS
                })
                await expect(marketRegistry.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("MR_NEP")
            })

            it("force error, pool is already existent in ClearingHouse", async () => {
                await marketRegistry.addPool(baseToken.address, DEFAULT_FEE)
                await expect(marketRegistry.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("MR_EP")
            })

            it("force error, pool is existed in Exchange even with the same base but diff fee", async () => {
                await marketRegistry.addPool(baseToken.address, DEFAULT_FEE)
                mockedUniV3Factory.smocked.getPool.will.return.with(
                    (token0: string, token1: string, feeRatio: BigNumber) => {
                        return POOL_B_ADDRESS
                    },
                )
                await expect(marketRegistry.addPool(baseToken.address, 10000)).to.be.revertedWith("MR_EP")
            })

            it("force error, base must be smaller than quote to force base = token0 and quote = token1", async () => {
                const tokenWithLongerAddr = await mockedBaseTokenTo(ADDR_GREATER_THAN, mockedQuoteToken.address)
                tokenWithLongerAddr.smocked.balanceOf.will.return.with(ethers.constants.MaxUint256)
                await expect(marketRegistry.addPool(tokenWithLongerAddr.address, DEFAULT_FEE)).to.be.revertedWith(
                    "MR_IB",
                )
            })

            it("force error, base token balance in clearing house not enough", async () => {
                const baseToken2 = await mockedBaseTokenTo(ADDR_LESS_THAN, mockedQuoteToken.address)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                mockedUniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await expect(marketRegistry.addPool(baseToken2.address, DEFAULT_FEE)).revertedWith("MR_CHBNE")
            })
        })
    })

    describe("onlyOwner setters", () => {
        beforeEach(async () => {
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            await baseToken.addWhitelist(mockedPool.address)
        })

        it("setClearingHouse", async () => {
            await marketRegistry.setClearingHouse(mockedClearingHouse.address)
            expect(await marketRegistry.getClearingHouse()).eq(mockedClearingHouse.address)
        })

        describe("after addPool", () => {
            beforeEach(async () => {
                await marketRegistry.setClearingHouse(mockedClearingHouse.address)
                await marketRegistry.addPool(baseToken.address, DEFAULT_FEE)
            })

            it("setFeeRatio", async () => {
                await marketRegistry.setFeeRatio(baseToken.address, 10000) // 1%
                expect(await marketRegistry.getFeeRatio(baseToken.address)).eq(10000)
            })

            it("force error, ratio overflow", async () => {
                const twoHundredPercent = 2000000 // 200% in uint24
                await expect(marketRegistry.setFeeRatio(baseToken.address, twoHundredPercent)).to.be.revertedWith(
                    "MR_RO",
                )
            })

            it("setInsuranceFundFeeRatio", async () => {
                await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, 10000) // 1%
                expect(await marketRegistry.getInsuranceFundFeeRatio(baseToken.address)).eq(10000)
            })

            it("force error, ratio overflow", async () => {
                const twoHundredPercent = 2000000 // 200% in uint24
                await expect(marketRegistry.setFeeRatio(baseToken.address, twoHundredPercent)).to.be.revertedWith(
                    "MR_RO",
                )
            })

            it("force error, ratio overflow", async () => {
                const twoHundredPercent = 2000000 // 200% in uint24
                await expect(
                    marketRegistry.setInsuranceFundFeeRatio(baseToken.address, twoHundredPercent),
                ).to.be.revertedWith("MR_RO")
            })

            it("force error, caller not owner", async () => {
                await expect(marketRegistry.connect(alice).setFeeRatio(baseToken.address, 10000)).to.be.revertedWith(
                    "SO_CNO",
                )
                await expect(
                    marketRegistry.connect(alice).setInsuranceFundFeeRatio(baseToken.address, 10000),
                ).to.be.revertedWith("SO_CNO")
                await expect(marketRegistry.connect(alice).setMaxOrdersPerMarket(1)).to.be.revertedWith("SO_CNO")
            })
        })

        it("force error, pool not exists", async () => {
            await expect(marketRegistry.setFeeRatio(baseToken.address, 10000)).to.be.revertedWith("MR_PNE")
            await expect(marketRegistry.setInsuranceFundFeeRatio(baseToken.address, 10000)).to.be.revertedWith("MR_PNE")
        })

        it("setMaxOrdersPerMarket", async () => {
            await marketRegistry.setMaxOrdersPerMarket(1)
            expect(await marketRegistry.getMaxOrdersPerMarket()).eq(1)
        })
    })
})
