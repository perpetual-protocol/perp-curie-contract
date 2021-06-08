import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapBroker, UniswapV3Pool } from "../../typechain"
import { poolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapBroker", () => {
    let pool: UniswapV3Pool
    let base: TestERC20
    let quote: TestERC20
    let uniswapBroker: TestUniswapBroker

    beforeEach(async () => {
        const { pool: _pool, base: _base, quote: _quote } = await waffle.loadFixture(poolFixture)
        pool = _pool
        base = _base
        quote = _quote
        await pool.initialize(encodePriceSqrt(1, 10))

        const uniswapBrokerFactory = await ethers.getContractFactory("TestUniswapBroker")
        uniswapBroker = (await uniswapBrokerFactory.deploy()) as TestUniswapBroker
    })

    describe("#mint", () => {
        it("mint", async () => {
            await expect(
                uniswapBroker.mint({
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
                    uniswapBroker.address,
                    uniswapBroker.address,
                    "50000",
                    "50200",
                    parseEther("1"),
                    parseEther("0.000816820841"),
                    parseEther("0.122414646"),
                )
        })
    })
})
