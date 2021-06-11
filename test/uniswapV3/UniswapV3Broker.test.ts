import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { poolFixture } from "../shared/fixtures"
import { encodePriceSqrt, token01toBaseQuote } from "../shared/utilities"

describe("UniswapV3Broker", () => {
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
        } = await waffle.loadFixture(poolFixture)
        pool = _pool
        baseToken = _baseToken
        quoteToken = _quoteToken

        const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
        uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker

        // broker has the only permission to mint vToken
        await baseToken.setMinter(uniswapV3Broker.address)
        await quoteToken.setMinter(uniswapV3Broker.address)
    })

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    describe("# mint", () => {
        it("mint range order above current price", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))

            // when above price, token1 = 0
            const token0 = parseEther("0.000816820841")
            const token1 = "0"
            const { base, quote } = token01toBaseQuote(baseToken.address, quoteToken.address, token0, token1)

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    tickLower: 50000,
                    tickUpper: 50200,
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "999999999994411796", // around 1
                    token0,
                    token1,
                )
        })

        it("mint range order under current price", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))

            // when under price, token0 = 0
            const token0 = "0"
            const token1 = parseEther("0.122414646")
            const { base, quote } = token01toBaseQuote(baseToken.address, quoteToken.address, token0, token1)

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    tickLower: "50000",
                    tickUpper: "50200",
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "1000000000109464931", // around 1
                    token0,
                    token1,
                )
        })
    })
})
