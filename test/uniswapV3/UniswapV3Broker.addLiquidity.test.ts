import { expect } from "chai"
import { hexlify, parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, QuoteToken, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { base0Quote1PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Broker addLiquidity", () => {
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

    it("cases (upper & lower) won't break the getPositionKey() computation", async () => {
        const posKey = await uniswapV3Broker.getPositionKey(50000, 50400)
        expect((await pool.positions(posKey)).liquidity.eq(0)).be.true
        await pool.initialize(encodePriceSqrt(151.3733069, 1))

        const base = parseEther("0.000808693720084599")
        const quote = parseEther("0.122414646")

        await uniswapV3Broker.addLiquidity({
            pool: pool.address,
            lowerTick: 50000, // 148.3760629
            upperTick: 50400, // 154.4310961
            base,
            quote,
            data: hexlify([]),
        })
        expect((await pool.positions(posKey)).liquidity.gt(0)).be.true
    })

    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=150902425
    it("mint range order includes current price", async () => {
        // the current price of token0 (base) = reserve1/reserve0 = 151.3733069/1
        // P(50200) = 1.0001^50200 ~= 151.3733069
        await pool.initialize(encodePriceSqrt(151.3733069, 1))

        const base = parseEther("0.000808693720084599")
        const quote = parseEther("0.122414646")

        // the emission of event is from Uniswap v3, with params representing the real minting conditions
        await expect(
            uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: 50000, // 148.3760629
                upperTick: 50400, // 154.4310961
                base,
                quote,
                data: hexlify([]),
            }),
        )
            .to.emit(pool, "Mint")
            .withArgs(
                uniswapV3Broker.address,
                uniswapV3Broker.address,
                50000,
                50400,
                "999999986406400213", // around 1
                base,
                quote,
            )
    })

    it("mint range order above current price", async () => {
        await pool.initialize(encodePriceSqrt(1, 1))

        // LP opens a range order above the current price means that LP expects the price of token0 (base) to rise,
        // and traders would like to buy token0, so LP provides token0 to be bought
        // when above price, token1 = 0
        const base = parseEther("0.000816820841")
        const quote = "0"

        // the emission of event is from Uniswap v3, with params representing the real minting conditions
        await expect(
            uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: 50000,
                upperTick: 50200,
                base,
                quote,
                data: hexlify([]),
            }),
        )
            .to.emit(pool, "Mint")
            .withArgs(
                uniswapV3Broker.address,
                uniswapV3Broker.address,
                50000,
                50200,
                "999999999994411796", // around 1
                base,
                quote,
            )
    })

    it("mint range order above current price should fail if we don't provide base", async () => {
        await pool.initialize(encodePriceSqrt(1, 1))

        const base = "0"
        const quote = parseEther("0.122414646")

        await expect(
            uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
                data: hexlify([]),
            }),
        ).to.be.reverted
    })

    it("mint range order under current price", async () => {
        await pool.initialize(encodePriceSqrt(200, 1))

        // LP opens a range order under the current price means that LP expects the price of token0 (base) to drop
        // and traders would like to sell token0, so LP provides token1 (quote) to buy traders' token0
        // when under price, token0 = 0
        const base = "0"
        const quote = parseEther("0.122414646")

        await expect(
            uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
                data: hexlify([]),
            }),
        )
            .to.emit(pool, "Mint")
            .withArgs(
                uniswapV3Broker.address,
                uniswapV3Broker.address,
                50000,
                50200,
                "1000000000109464931", // around 1
                base,
                quote,
            )
    })

    it("mint range order under current price should fail if we don't provide quote", async () => {
        await pool.initialize(encodePriceSqrt(200, 1))

        const base = parseEther("0.000816820841")
        const quote = "0"

        await expect(
            uniswapV3Broker.addLiquidity({
                pool: pool.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
                data: hexlify([]),
            }),
        ).to.be.reverted
    })
})
