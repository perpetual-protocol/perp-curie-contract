import { MockContract, smockit } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers, waffle } from "hardhat"
import { Exchange, UniswapV3Pool } from "../../typechain"
import { ADDR_GREATER_THAN, ADDR_LESS_THAN, mockedBaseTokenTo } from "../clearingHouse/fixtures"
import { mockedExchangeFixture } from "./fixtures"

describe("Exchange Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000B"
    const DEFAULT_FEE = 3000

    let exchange: Exchange
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract

    beforeEach(async () => {
        const _exchangeFixtures = await loadFixture(mockedExchangeFixture)
        exchange = _exchangeFixtures.exchange
        baseToken = _exchangeFixtures.mockedBaseToken
        quoteToken = _exchangeFixtures.mockedQuoteToken
        uniV3Factory = _exchangeFixtures.mockedUniV3Factory

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        baseToken.smocked.getIndexPrice.will.return.with(parseEther("100"))
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
        })

        describe("after the pool is initialized", () => {
            beforeEach(async () => {
                mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            })

            // @SAMPLE - addPool
            it("add a UniswapV3 pool and send an event", async () => {
                // check event has been sent
                await expect(exchange.addPool(baseToken.address, DEFAULT_FEE))
                    .to.emit(exchange, "PoolAdded")
                    .withArgs(baseToken.address, DEFAULT_FEE, mockedPool.address)

                expect(await exchange.getPool(baseToken.address)).to.eq(mockedPool.address)
            })

            it("add multiple UniswapV3 pools", async () => {
                await exchange.addPool(baseToken.address, DEFAULT_FEE)
                expect(await exchange.getPool(baseToken.address)).to.eq(mockedPool.address)

                const baseToken2 = await mockedBaseTokenTo(ADDR_LESS_THAN, quoteToken.address)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                uniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await exchange.addPool(baseToken2.address, DEFAULT_FEE)
                // verify isPoolExisted
                expect(await exchange.getPool(baseToken2.address)).to.eq(mockedPool2.address)
            })

            it("force error, pool is not existent in uniswap v3", async () => {
                uniV3Factory.smocked.getPool.will.return.with(() => {
                    return EMPTY_ADDRESS
                })
                await expect(exchange.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_NEP")
            })

            it("force error, pool is already existent in ClearingHouse", async () => {
                await exchange.addPool(baseToken.address, DEFAULT_FEE)
                await expect(exchange.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_EP")
            })

            it("force error, pool is existed in Exchange even with the same base but diff fee", async () => {
                await exchange.addPool(baseToken.address, DEFAULT_FEE)
                uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                    return POOL_B_ADDRESS
                })
                await expect(exchange.addPool(baseToken.address, 10000)).to.be.revertedWith("EX_EP")
            })

            it("force error, base must be smaller than quote to force base = token0 and quote = token1", async () => {
                const tokenWithLongerAddr = await mockedBaseTokenTo(ADDR_GREATER_THAN, quoteToken.address)
                await expect(exchange.addPool(tokenWithLongerAddr.address, DEFAULT_FEE)).to.be.revertedWith("EX_IB")
            })
        })

        it("force error, before the pool is initialized", async () => {
            await expect(exchange.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_PNI")
        })
    })

    describe("onlyOwner setters", () => {
        it("setMaxTickCrossedWithinBlock", async () => {
            await expect(exchange.setMaxTickCrossedWithinBlock(baseToken.address, 200)).to.be.revertedWith("EX_BTNE")

            // add pool
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            await exchange.addPool(baseToken.address, DEFAULT_FEE)

            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 200)
            expect(await exchange.getMaxTickCrossedWithinBlock(baseToken.address)).eq(200)
        })

        it("setFeeRatio", async () => {
            const twoHundredPercent = 2000000 // 200% in uint24
            await expect(exchange.setFeeRatio(baseToken.address, twoHundredPercent)).to.be.revertedWith("EX_RO")
            await exchange.setFeeRatio(baseToken.address, 10000) // 1%
            expect(await exchange.getFeeRatio(baseToken.address)).eq(10000)
        })

        it("setMaxTickCrossedWithinBlock", async () => {
            await expect(exchange.setMaxTickCrossedWithinBlock(baseToken.address, 200)).to.be.revertedWith("EX_BTNE")

            // add pool
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            await exchange.addPool(baseToken.address, DEFAULT_FEE)

            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 200)
            expect(await exchange.getMaxTickCrossedWithinBlock(baseToken.address)).eq(200)
        })
    })
})
