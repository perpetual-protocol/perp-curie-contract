import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { poolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Broker", () => {
    let pool: UniswapV3Pool
    let base: TestERC20
    let quote: TestERC20
    let uniswapV3Broker: TestUniswapV3Broker

    beforeEach(async () => {
        const { factory, pool: _pool, base: _base, quote: _quote } = await waffle.loadFixture(poolFixture)
        pool = _pool
        base = _base
        quote = _quote
        await pool.initialize(encodePriceSqrt(1, 10))

        const __pool = await factory.getPool(await pool.token0(), await pool.token1(), await pool.fee())
        console.log(`pool addr: ${__pool}`)

        const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
        uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker
    })

    describe("#mint", () => {
        it("mint", async () => {
            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: base.address,
                    quoteToken: quote.address,
                    tickLower: "50000",
                    tickUpper: "50200",
                    baseAmount: parseEther("0.000816820841"),
                    quoteAmount: parseEther("0.122414646"),
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    "50000",
                    "50200",
                    parseEther("1"),
                    parseEther("0.000816820841"),
                    parseEther("0.122414646"),
                )
        })
    })
})
