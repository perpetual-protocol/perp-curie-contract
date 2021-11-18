import { expect } from "chai"
import { hexlify, parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, QuoteToken, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { base0Quote1PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Broker removeLiquidity", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let uniswapV3Broker: TestUniswapV3Broker

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
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
        uniswapV3Broker = (await UniswapV3BrokerFactory.deploy()) as TestUniswapV3Broker
        await uniswapV3Broker.initialize(factory.address)

        // broker has the only permission to mint vToken
        await baseToken.mintMaximumTo(uniswapV3Broker.address)
        await quoteToken.mintMaximumTo(uniswapV3Broker.address)
        await baseToken.addWhitelist(uniswapV3Broker.address)
        await quoteToken.addWhitelist(uniswapV3Broker.address)
        await baseToken.addWhitelist(pool.address)
        await quoteToken.addWhitelist(pool.address)
    })

    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=150902425
    describe("remove non-zero liquidity", () => {
        it("burn and get 100% quote token", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))
            const base = "0"
            const quote = parseEther("0.122414646")
            await uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
                data: hexlify([]),
            })

            await expect(
                uniswapV3Broker.removeLiquidity({
                    pool: pool.address,
                    recipient: uniswapV3Broker.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    liquidity: "1000000000109464931", // around 1
                }),
            )
                .to.emit(pool, "Burn")
                .withArgs(
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "1000000000109464931", // around 1
                    base,
                    "122414645999999999", // rounding error, it's around 0.122414646
                )
        })

        it("burn and get 50% quote token", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))
            const base = "0"
            const quote = parseEther("0.122414646")

            await uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
                data: hexlify([]),
            })

            await expect(
                uniswapV3Broker.removeLiquidity({
                    pool: pool.address,
                    recipient: uniswapV3Broker.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    liquidity: "500000000054732465", // around 0.5
                }),
            )
                .to.emit(pool, "Burn")
                .withArgs(
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "500000000054732465", // around 0.5
                    base,
                    "61207322999999999", // quote.div(2)
                )
        })

        it("burn and get 100% base token", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))
            const base = parseEther("0.000816820841")
            const quote = "0"

            await uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: 50000,
                upperTick: 50200,
                base,
                quote,
                data: hexlify([]),
            })

            await expect(
                uniswapV3Broker.removeLiquidity({
                    pool: pool.address,
                    recipient: uniswapV3Broker.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    liquidity: "999999999994411796", // around 1
                }),
            )
                .to.emit(pool, "Burn")
                .withArgs(
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "999999999994411796", // around 1
                    "816820840999999", // rounding error, around 0.000816820841
                    "0",
                )
        })

        it("burn and get 100% quote and base token", async () => {
            await pool.initialize(encodePriceSqrt(151.3733069, 1))

            await uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: 50000, // 148.3760629
                upperTick: 50400, // 154.4310961
                base: parseEther("0.000808693720084599"),
                quote: parseEther("0.122414646"),
                data: hexlify([]),
            })

            await expect(
                uniswapV3Broker.removeLiquidity({
                    pool: pool.address,
                    recipient: uniswapV3Broker.address,
                    lowerTick: "50000",
                    upperTick: "50400",
                    liquidity: "999999986406400213", // around 1
                }),
            )
                .to.emit(pool, "Burn")
                .withArgs(
                    uniswapV3Broker.address,
                    50000,
                    50400,
                    "999999986406400213", // around 1
                    "808693720084598", // rounding error, around 0.000808693720084599
                    "122414645999999999", // rounding error, around 0.122414646
                )
        })
    })

    describe("remove zero liquidity, expect to collect fee", () => {
        it("no swap no fee", async () => {
            // the current price of token0 (base) = reserve1/reserve0 = 151.3733069/1
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))

            await uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: "50000",
                upperTick: "50200",
                base: parseEther("0.000808693720084599"),
                quote: parseEther("0.122414646"),
                data: hexlify([]),
            })

            const tx = await uniswapV3Broker.removeLiquidity({
                pool: pool.address,
                recipient: uniswapV3Broker.address,
                lowerTick: "50000",
                upperTick: "50200",
                liquidity: "0",
            })

            await expect(tx).to.emit(pool, "Burn").withArgs(uniswapV3Broker.address, 50000, 50200, "0", "0", "0")
            await expect(tx)
                .to.emit(pool, "Collect")
                .withArgs(uniswapV3Broker.address, uniswapV3Broker.address, 50000, 50200, "0", "0")
        })

        it("get base fee after a swap from base to quote happens", async () => {
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))

            await uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: 50000, // 148.3760629
                upperTick: 50200, // 151.3733069
                base: "0",
                quote: parseEther("0.122414646"),
                data: hexlify([]),
            })

            // 0.0004084104205 / 0.99 = 0.0004125357783
            const base = 0.0004125357783

            // exact base -> quote
            await uniswapV3Broker.swap({
                pool: pool.address,
                recipient: uniswapV3Broker.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther(base.toString()),
                sqrtPriceLimitX96: "0",
                data: hexlify([]),
            })

            const tx = await uniswapV3Broker.removeLiquidity({
                pool: pool.address,
                recipient: uniswapV3Broker.address,
                lowerTick: "50000",
                upperTick: "50200",
                liquidity: "0",
            })

            await expect(tx).to.emit(pool, "Burn").withArgs(uniswapV3Broker.address, 50000, 50200, "0", "0", "0")
            await expect(tx)
                .to.emit(pool, "Collect")
                // expect 1% of base = 0.000004125357783
                // there's one wei of imprecision, thus expecting 0.000004125357782999
                .withArgs(uniswapV3Broker.address, uniswapV3Broker.address, 50000, 50200, "4125357782999", "0")
        })

        it("force error, no liquidity", async () => {
            await expect(
                uniswapV3Broker.removeLiquidity({
                    pool: pool.address,
                    recipient: uniswapV3Broker.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50400, // 154.4310961
                    liquidity: parseEther("1"),
                }),
            ).to.be.reverted
        })
    })
})
