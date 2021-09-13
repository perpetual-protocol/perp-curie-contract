import { MockContract, smockit } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers, waffle } from "hardhat"
import { Exchange, ExchangeRegistry, OrderBook, UniswapV3Pool } from "../../typechain"
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
    let exchangeRegistry: ExchangeRegistry
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract

    beforeEach(async () => {
        const _exchangeFixtures = await loadFixture(mockedExchangeFixture)
        exchange = _exchangeFixtures.exchange
        exchangeRegistry = _exchangeFixtures.exchangeRegistry
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

            it("add multiple UniswapV3 pools", async () => {
                await exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE)
                expect(await exchange.getPool(baseToken.address)).to.eq(mockedPool.address)

                const baseToken2 = await mockedBaseTokenTo(ADDR_LESS_THAN, quoteToken.address)
                baseToken2.smocked.balanceOf.will.return.with(ethers.constants.MaxUint256)
                baseToken2.smocked.isInWhitelist.will.return.with(true)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                uniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await exchangeRegistry.addPool(baseToken2.address, DEFAULT_FEE)
                // verify isPoolExisted
                expect(await exchange.getPool(baseToken2.address)).to.eq(mockedPool2.address)
            })

            it("force error, pool is not existent in uniswap v3", async () => {
                uniV3Factory.smocked.getPool.will.return.with(() => {
                    return EMPTY_ADDRESS
                })
                await expect(exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_NEP")
            })

            it("force error, pool is already existent in ClearingHouse", async () => {
                await exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE)
                await expect(exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_EP")
            })

            it("force error, pool is existed in Exchange even with the same base but diff fee", async () => {
                await exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE)
                uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                    return POOL_B_ADDRESS
                })
                await expect(exchangeRegistry.addPool(baseToken.address, 10000)).to.be.revertedWith("EX_EP")
            })

            it("force error, base must be smaller than quote to force base = token0 and quote = token1", async () => {
                const tokenWithLongerAddr = await mockedBaseTokenTo(ADDR_GREATER_THAN, quoteToken.address)
                tokenWithLongerAddr.smocked.balanceOf.will.return.with(ethers.constants.MaxUint256)
                await expect(exchangeRegistry.addPool(tokenWithLongerAddr.address, DEFAULT_FEE)).to.be.revertedWith(
                    "EX_IB",
                )
            })

            it("force error, base token balance in clearing house not enough", async () => {
                const baseToken2 = await mockedBaseTokenTo(ADDR_LESS_THAN, quoteToken.address)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                uniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await expect(exchangeRegistry.addPool(baseToken2.address, DEFAULT_FEE)).revertedWith("EX_CHBNE")
            })
        })

        it("force error, before the pool is initialized", async () => {
            await expect(exchangeRegistry.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_PNI")
        })
    })
})
