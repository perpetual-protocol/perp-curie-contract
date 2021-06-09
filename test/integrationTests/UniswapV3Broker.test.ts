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

        const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
        uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker

        // broker has the only permission to mint vToken
        await base.setMinter(uniswapV3Broker.address)
        await quote.setMinter(uniswapV3Broker.address)
    })

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    describe("#mint", () => {
        it("mint range order above current price", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))

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
                    50000,
                    50200,
                    "999999999994411796", // around 1
                    parseEther("0.000816820841"),
                    parseEther("0"),
                )
        })

        it("mint range order under current price", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: base.address,
                    quoteToken: quote.address,
                    tickLower: "50000",
                    tickUpper: "50200",
                    baseAmount: parseEther("0"),
                    quoteAmount: parseEther("0.122414646"),
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "1000000000109464931", // around 1
                    parseEther("0"),
                    parseEther("0.122414646"),
                )
        })
    })
})
