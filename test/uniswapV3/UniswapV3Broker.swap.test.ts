import { expect } from "chai"
import { hexlify, parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, QuoteToken, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { base0Quote1PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Broker swap", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let quoteToken: QuoteToken
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

    describe("no liquidity", () => {
        it("force error, tx should fail", async () => {
            // the current price of token0 (base) = reserve1/reserve0 = 148.3760629/1
            // P(50000) = 1.0001^50000 ~= 148.3760629
            await pool.initialize(encodePriceSqrt(148.3760629, 1))

            const quote = parseEther("0.1135501475")
            await expect(
                uniswapV3Broker.swap({
                    pool: pool.address,
                    recipient: uniswapV3Broker.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: quote,
                    sqrtPriceLimitX96: "0",
                    data: hexlify([]),
                }),
            ).to.be.revertedWith("CH_F0S")
        })
    })

    describe("liquidity = 1 (10^18)", () => {
        describe("initial price = 148.3760629", () => {
            beforeEach(async () => {
                // the current price of token0 (base) = reserve1/reserve0 = 148.3760629/1
                // P(50000) = 1.0001^50000 ~= 148.3760629
                await pool.initialize(encodePriceSqrt(148.3760629, 1))
            })

            it("exact quote -> base", async () => {
                await uniswapV3Broker.addLiquidity({
                    pool: pool.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50200, // 151.3733069
                    base: parseEther("0.000816820841"),
                    quote: "0",
                    data: hexlify([]),
                })

                // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
                // the sheet does not take tx fee into consideration; thus, divide the value on sheet by 0.99
                // 0.112414646 / 0.99 = 0.1135501475
                const quote = parseEther("0.1135501475")
                await expect(
                    uniswapV3Broker.swap({
                        pool: pool.address,
                        recipient: uniswapV3Broker.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: quote,
                        sqrtPriceLimitX96: "0",
                        data: hexlify([]),
                    }),
                )
                    .to.emit(pool, "Swap")
                    .withArgs(
                        uniswapV3Broker.address,
                        uniswapV3Broker.address,
                        parseEther("-0.000750705258114652"),
                        quote,
                        "973982383197523125365247178066",
                        "999999999994411796", // around 1
                        50183, // floor(tick index of the current price)
                    )
                // sqrt(151.1273391) * (2^96) = 9.739823831E29 ~= 973982383197523125365247178066
                // -> (973982383197523125365247178066 / (2 ^ 96)) ^ 2 = 151.1273391399
                // 1.0001 ^ 50183.73689 = 151.1273391471
            })

            it("quote -> exact base", async () => {
                await uniswapV3Broker.addLiquidity({
                    pool: pool.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50200, // 151.3733069
                    base: parseEther("0.000816820841"),
                    quote: "0",
                    data: hexlify([]),
                })

                const base = 0.000750705258114652
                await expect(
                    uniswapV3Broker.swap({
                        pool: pool.address,
                        recipient: uniswapV3Broker.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: parseEther(base.toString()),
                        sqrtPriceLimitX96: "0",
                        data: hexlify([]),
                    }),
                )
                    .to.emit(pool, "Swap")
                    .withArgs(
                        uniswapV3Broker.address,
                        uniswapV3Broker.address,
                        parseEther((-base).toString()),
                        // can check out numbers in the case "exact quote -> base"
                        parseEther("0.113550147499999924"),
                        "973982383197523119302772529062",
                        "999999999994411796", // around 1
                        50183, // floor(tick index of the current price)
                    )
                // sqrt(151.1273391) * (2^96) = 9.739823831E29 ~= 973982383197523125365247178066
                // -> (973982383197523125365247178066 / (2 ^ 96)) ^ 2 = 151.1273391399
                // 1.0001 ^ 50183.73689 = 151.1273391471
            })
        })

        describe("initial price = 151.3733069", () => {
            beforeEach(async () => {
                // P(50200) = 1.0001^50200 ~= 151.3733069
                await pool.initialize(encodePriceSqrt(151.3733069, 1))
            })

            it("exact base -> quote", async () => {
                await uniswapV3Broker.addLiquidity({
                    pool: pool.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50200, // 151.3733069
                    base: "0",
                    quote: parseEther("0.122414646"),
                    data: hexlify([]),
                })

                // 0.0004084104205 / 0.99 = 0.0004125357783
                const base = parseEther("0.0004125357783")
                await expect(
                    uniswapV3Broker.swap({
                        pool: pool.address,
                        recipient: uniswapV3Broker.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: base,
                        sqrtPriceLimitX96: "0",
                        data: hexlify([]),
                    }),
                )
                    .to.emit(pool, "Swap")
                    .withArgs(
                        uniswapV3Broker.address,
                        uniswapV3Broker.address,
                        base,
                        parseEther("-0.061513341759797928"),
                        "969901075782366361490154736876",
                        "1000000000109464931", // around 1
                        50099, // floor(tick index of the current price)
                    )
                // sqrt(149.863446) * (2^96) = 9.699010759E29 ~= 969901075782366361490154736876
                // -> (969901075782366361490154736876 / (2 ^ 96)) ^ 2 = 149.8634459755
                // 1.0001 ^ 50099.75001 = 149.8634459223
            })

            it("base -> exact quote", async () => {
                await uniswapV3Broker.addLiquidity({
                    pool: pool.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50200, // 151.3733069
                    base: "0",
                    quote: parseEther("0.122414646"),
                    data: hexlify([]),
                })

                const quote = 0.061513341759797928
                await expect(
                    uniswapV3Broker.swap({
                        pool: pool.address,
                        recipient: uniswapV3Broker.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        amount: parseEther(quote.toString()),
                        sqrtPriceLimitX96: "0",
                        data: hexlify([]),
                    }),
                )
                    .to.emit(pool, "Swap")
                    .withArgs(
                        uniswapV3Broker.address,
                        uniswapV3Broker.address,
                        // can check out numbers in the case "exact base -> quote"
                        parseEther("0.0004125357783"),
                        parseEther((-quote).toString()),
                        "969901075782366361754130049404",
                        "1000000000109464931", // around 1
                        50099, // floor(tick index of the current price)
                    )
                // sqrt(149.863446) * (2^96) = 9.699010759E29 ~= 969901075782366361490154736876
                // -> (969901075782366361490154736876 / (2 ^ 96)) ^ 2 = 149.8634459755
                // 1.0001 ^ 50099.75001 = 149.8634459223
            })
        })
    })

    describe("liquidity = 10 (10^19)", () => {
        it("exact quote -> base", async () => {
            // the current price of token0 (base) = reserve1/reserve0 = 148.3760629/1
            // P(50000) = 1.0001^50000 ~= 148.3760629
            await pool.initialize(encodePriceSqrt(148.3760629, 1))

            await uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: 50000, // 148.3760629
                upperTick: 50200, // 151.3733069
                base: parseEther("0.00816820841"),
                quote: "0",
                data: hexlify([]),
            })

            // 1.12414646 / 0.99 = 1.135501475
            const quote = parseEther("1.135501475")
            await expect(
                uniswapV3Broker.swap({
                    pool: pool.address,
                    recipient: uniswapV3Broker.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: quote,
                    sqrtPriceLimitX96: "0",
                    data: hexlify([]),
                }),
            )
                .to.emit(pool, "Swap")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    parseEther("-0.007507052581146525"),
                    quote,
                    "973982383197523125362575256312",
                    "9999999999944117963", // around 10
                    50183, // floor(tick index of the current price)
                )
            // sqrt(151.1273391) * (2^96) = 9.739823831E29 ~= 973982383197523125365247178066
            // -> (973982383197523125365247178066 / (2 ^ 96)) ^ 2 = 151.1273391399
            // 1.0001 ^ 50183.73689 = 151.1273391471
        })
    })
})
