import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { base0Quote1PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Broker", () => {
    let pool: UniswapV3Pool
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let uniswapV3Broker: TestUniswapV3Broker

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    describe("# burn: isBase0Quote1 / token0 == base", () => {
        beforeEach(async () => {
            const {
                factory,
                pool: _pool,
                baseToken: _baseToken,
                quoteToken: _quoteToken,
            } = await waffle.loadFixture(base0Quote1PoolFixture)
            pool = _pool
            baseToken = _baseToken
            quoteToken = _quoteToken

            const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
            uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker

            // broker has the only permission to mint vToken
            await baseToken.setMinter(uniswapV3Broker.address)
            await quoteToken.setMinter(uniswapV3Broker.address)
        })

        // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=150902425
        it("burn and get 100% quote token", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))
            const base = "0"
            const quote = parseEther("0.122414646")
            const mintParams = {
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
            }
            await uniswapV3Broker.mint(mintParams)

            await expect(uniswapV3Broker.burn(mintParams)).to.emit(pool, "Burn").withArgs(
                uniswapV3Broker.address,
                50000,
                50200,
                "1000000000109464931", // around 1
                base,
                quote,
            )
        })

        it("burn and get 50% quote token", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))
            const base = "0"
            const quote = parseEther("0.122414646")
            const mintParams = {
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
            }
            await uniswapV3Broker.mint(mintParams)

            await expect(
                uniswapV3Broker.burn({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base,
                    quote: quote.div(2),
                }),
            )
                .to.emit(pool, "Burn")
                .withArgs(
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "500000000109464931", // around 0.5
                    base,
                    quote.div(2),
                )
        })

        // FIXME: add partial burn cases for all the following cases in the future
        it("burn and get 100% base token", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))
            const base = parseEther("0.000816820841")
            const quote = "0"
            const mintParams = {
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                lowerTick: 50000,
                upperTick: 50200,
                base,
                quote,
            }
            await uniswapV3Broker.mint(mintParams)

            await expect(uniswapV3Broker.burn(mintParams)).to.emit(pool, "Burn").withArgs(
                uniswapV3Broker.address,
                uniswapV3Broker.address,
                50000,
                50200,
                "999999999994411796", // around 1
                base,
                quote,
            )
        })

        it("burn and get 100% quote and base token", async () => {
            await pool.initialize(encodePriceSqrt(151.3733069, 1))
            const base = parseEther("0.000808693720084599")
            const quote = parseEther("0.122414646")
            const mintParams = {
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                lowerTick: 50000, // 148.3760629
                upperTick: 50400, // 154.4310961
                base,
                quote,
            }
            await uniswapV3Broker.mint(mintParams)

            await expect(uniswapV3Broker.burn(mintParams)).to.emit(pool, "Burn").withArgs(
                uniswapV3Broker.address,
                uniswapV3Broker.address,
                50000,
                50400,
                "999999986406400213", // around 1
                base,
                quote,
            )
        })

        it("burn zero liquidity when no liquidity", async () => {
            const base = parseEther("1")
            const quote = parseEther("1")
            await expect(
                uniswapV3Broker.burn({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50400, // 154.4310961
                    base,
                    quote,
                }),
            ).not.to.emit(pool, "Burn")
        })

        it("burn zero liquidity when there was only quote liquidity", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))
            const base = "0"
            const quote = parseEther("0.122414646")
            const mintParams = {
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                lowerTick: "50000",
                upperTick: "50200",
                base,
                quote,
            }
            await uniswapV3Broker.mint(mintParams)

            await expect(
                uniswapV3Broker.burn({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base: parseEther("1"),
                    quote: parseEther("0"),
                }),
            ).not.to.emit(pool, "Burn")
        })
    })
})
