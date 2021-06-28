import { TestERC20, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { ethers, waffle } from "hardhat"

import { base0Quote1PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"
import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"

describe("UniswapV3Broker removeLiquidity", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    let pool: UniswapV3Pool
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let uniswapV3Broker: TestUniswapV3Broker

    beforeEach(async () => {
        const {
            factory,
            pool: _pool,
            baseToken: _baseToken,
            quoteToken: _quoteToken,
        } = await loadFixture(base0Quote1PoolFixture)
        pool = _pool
        baseToken = _baseToken
        quoteToken = _quoteToken

        const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
        uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker

        // broker has the only permission to mint vToken
        await baseToken.setMinter(uniswapV3Broker.address)
        await quoteToken.setMinter(uniswapV3Broker.address)
    })

    it("collect no tokens, if there is no swap happened", async () => {
        // the current price of token0 (base) = reserve1/reserve0 = 151.3733069/1
        // P(50200) = 1.0001^50200 ~= 151.3733069
        await pool.initialize(encodePriceSqrt(151.3733069, 1))

        const addLiquidityParams = {
            pool: pool.address,
            baseToken: baseToken.address,
            quoteToken: quoteToken.address,
            lowerTick: "50000",
            upperTick: "50200",
            base: parseEther("0.000808693720084599"),
            quote: parseEther("0.122414646"),
        }
        await uniswapV3Broker.addLiquidity(addLiquidityParams)

        const removeLiquidityParams = {
            pool: pool.address,
            lowerTick: "50000",
            upperTick: "50200",
            liquidity: "0",
        }
        await expect(uniswapV3Broker.removeLiquidity(removeLiquidityParams))
            .to.emit(pool, "Burn")
            .withArgs(uniswapV3Broker.address, 50000, 50200, "0", "0", "0")
            .to.emit(pool, "Collect")
            .withArgs(uniswapV3Broker.address, uniswapV3Broker.address, 50000, 50200, "0", "0")
    })

    it("collect proper token's amount, if there is a swap happened", async () => {
        // P(50200) = 1.0001^50200 ~= 151.3733069
        await pool.initialize(encodePriceSqrt(151.3733069, 1))

        await uniswapV3Broker.addLiquidity({
            pool: pool.address,
            baseToken: baseToken.address,
            quoteToken: quoteToken.address,
            lowerTick: 50000, // 148.3760629
            upperTick: 50200, // 151.3733069
            base: "0",
            quote: parseEther("0.122414646"),
        })

        // 0.0004084104205 / 0.99 = 0.0004125357783
        const base = 0.0004125357783
        // fee = 1%
        const fee = "10000"

        // exact base -> quote
        await uniswapV3Broker.swap({
            pool: pool.address,
            baseToken: baseToken.address,
            quoteToken: quoteToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            amount: parseEther(base.toString()),
            sqrtPriceLimitX96: "0",
        })

        const removeLiquidityParams = {
            pool: pool.address,
            lowerTick: "50000",
            upperTick: "50200",
            liquidity: "0",
        }

        await expect(uniswapV3Broker.removeLiquidity(removeLiquidityParams))
            .to.emit(pool, "Burn")
            .withArgs(uniswapV3Broker.address, 50000, 50200, "0", "0", "0")
            .to.emit(pool, "Collect")
            // expect 1% of base = 0.000004125357783
            // there's one wei of imprecision, thus expecting 0.000004125357782999
            .withArgs(uniswapV3Broker.address, uniswapV3Broker.address, 50000, 50200, "4125357782999", "0")
    })
})

// describe("one maker", () => {
// 	describe("in maker's range", () => {
// 		it("received 0.1 base, if a trader swap 10 base to quote in my range", () => {})

// 		it("received 10 quote, if a trader swap 1000 quote to base in my range", () => {})

// 		it("received quote and base, if swap quote -> base and base -> quote happened in my range", () => {})

// 		it("cannot receive tx fee after removed liquidity", () => {})
// 	})
// })

// describe("multi makers", () => {
// 	describe("in maker's range", () => {
// 		it("received quote and base, if swap quote -> base and base -> quote happened in my range", () => {})

// 		it("cannot receive tx fee after removed liquidity", () => {})
// 	})

// 	describe("out of maker's range", () => {
// 		it("received nothing, if a trader swap 1000 quote to base in my range", () => {})
// 	})
// })
