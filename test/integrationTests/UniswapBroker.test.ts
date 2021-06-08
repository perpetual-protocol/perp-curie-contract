import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapBroker } from "../../typechain"
import { UniswapV3Pool } from "../../typechain/uniswap"
import { poolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapBroker", () => {
    let pool: UniswapV3Pool
    let token0: TestERC20
    let token1: TestERC20
    let uniswapBroker: TestUniswapBroker

    beforeEach(async () => {
        const { pool: _pool, token0: _token0, token1: _token1 } = await waffle.loadFixture(poolFixture)
        pool = _pool
        token0 = _token0
        token1 = _token1
        await pool.initialize(encodePriceSqrt(1, 10))

        const uniswapBrokerFactory = await ethers.getContractFactory("TestUniswapBroker")
        uniswapBroker = (await uniswapBrokerFactory.deploy()) as TestUniswapBroker
    })

    describe("#mint", () => {
        it("mint", async () => {
            await expect(
                uniswapBroker.mint({
                    pool: pool.address,
                    tickLower: "50000",
                    tickUpper: "50200",
                    base: parseEther("0.000816820841"),
                    quote: parseEther("0.122414646"),
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
