import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { base0Quote1PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Broker", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    let pool: UniswapV3Pool
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let uniswapV3Broker: TestUniswapV3Broker
    let admin: SignerWithAddress

    beforeEach(async () => {
        admin = (await ethers.getSigners())[0]
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

    describe.only("# swap", () => {
        it.skip("force error, when there's no liquidity", async () => {
            // the current price of token0 (base) = reserve1/reserve0 = 151.3733069/1
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))

            const base = parseEther("0.000808693720084599")
            const quote = parseEther("0.122414646")
        })

        it("swapQuoteToExactBase", async () => {
            // case 2
            // assume base = ETH
            // pay ? USDC can I get 0.1 ETH
            // -------------------------
            // baseToken = ETH
            // quoteToken = USDC
            // isBaseToQuote = false
            // isExactInput = false
            // amount = 0.1

            // the current price of token0 (base) = reserve1/reserve0 = 148.3760629/1
            // P(50000) = 1.0001^50000 ~= 148.3760629
            await pool.initialize(encodePriceSqrt(148.3760629, 1))

            await uniswapV3Broker.mint({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                lowerTick: 50000, // 148.3760629
                upperTick: 50200, // 151.3733069
                base: parseEther("0.000808693720084599"),
                quote: "0",
            })

            const quote = parseEther("0.122414646")
            const fee = parseEther("0.01")
            await uniswapV3Broker.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: quote,
                sqrtPriceLimitX96: "0",
                data: {
                    // path: params.tokenOut, params.fee, params.tokenIn
                    path: ethers.utils.defaultAbiCoder.encode(
                        ["string", "string", "string"],
                        [baseToken.address, fee, quoteToken.address],
                    ),
                    payer: admin.address,
                },
            })
        })

        it("swapExactBaseToQuote", async () => {
            // case 0
            // assume base = ETH
            // pay 0.1 ETH to get ? USDC
            // -------------------------
            // baseToken = ETH
            // quoteToken = USDC
            // isBaseToQuote = true
            // isExactInput = true
            // amount = 0.1

            // path: params.tokenIn, params.fee, params.tokenOut

            // the current price of token0 (base) = reserve1/reserve0 = 151.3733069/1
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))

            const base = parseEther("0.000808693720084599")
            const quote = parseEther("0.122414646")
        })
    })

    // case0:
    // 0. ETH = token0, USDC = token1
    // 1. ETH -> USDC => isBaseToQuote = true
    // 2. exact 2.5 ETH => isExactInput = true
    // - isZeroForOne = true
    // - amountWithSignDigit = 2.5
    // ---------------------------------------
    // amount0 = 2.5
    // amount1 = -x
    // deltaAmount = x
    // response.quote = -(-x)
    // response.base = amount0 = 2.5

    // case1:
    // 0. ETH = token0, USDC = token1
    // 1. ETH -> USDC => isBaseToQuote = true
    // 2. exact 2000 USDC => isExactInput = false
    // - isZeroForOne = true
    // - amountWithSignDigit = -2000
    // ---------------------------------------
    // amount0 = x
    // amount1 = -(2000)
    // deltaAmount = x
    // amountOutReceived = -(-(2000))
    // response.base = x
    // response.quote = amountOutReceived = -(-(2000))

    // case2:
    // 0. ETH = token0, USDC = token1
    // 1. USDC -> ETH => isBaseToQuote = false
    // 2. exact 2.5 ETH => isExactInput = false
    // - isZeroForOne = false
    // - amountWithSignDigit = -2.5
    // ---------------------------------------
    // amount0 = -2.5
    // amount1 = x
    // deltaAmount = x
    // amountOutReceived = -(-2.5)
    // response.quote = x
    // response.base = amountOutReceived = -(-2.5)

    // case3:
    // 0. ETH = token0, USDC = token1
    // 1. USDC -> ETH => isBaseToQuote = false
    // 2. exact 2000 USDC => isExactInput = true
    // - isZeroForOne = false
    // - amountWithSignDigit = 2000
    // ---------------------------------------
    // amount0 = -x
    // amount1 = 2000
    // deltaAmount = -(-x)
    // response.base = -(-x)
    // response.quote = amount1 = 2000

    // =======================================

    // case4:
    // 0. USDC = token0, ETH = token1
    // 1. ETH -> USDC => isBaseToQuote = true
    // 2. exact 2.5 ETH => isExactInput = true
    // - isZeroForOne = false
    // - amountWithSignDigit = 2.5
    // ---------------------------------------
    // amount0 = -x
    // amount1 = 2.5
    // deltaAmount = -(-x)
    // response.quote = -(-x)
    // response.base = amount1 = 2.5

    // case5:
    // 0. USDC = token0, ETH = token1
    // 1. ETH -> USDC => isBaseToQuote = true
    // 2. exact 2000 USDC => isExactInput = false
    // - isZeroForOne = false
    // - amountWithSignDigit = -2000
    // ---------------------------------------
    // amount0 = -(2000)
    // amount1 = x
    // deltaAmount = x
    // amountOutReceived = -(-(2000))
    // response.base = x
    // response.quote = amountOutReceived = -(-(2000))

    // case6:
    // 0. USDC = token0, ETH = token1
    // 1. USDC -> ETH => isBaseToQuote = false
    // 2. exact 2.5 ETH => isExactInput = false
    // - isZeroForOne = true
    // - amountWithSignDigit = -2.5
    // ---------------------------------------
    // amount0 = x
    // amount1 = -2.5
    // deltaAmount = x
    // amountOutReceived = -(-2.5)
    // response.quote = x
    // response.base = amountOutReceived = -(-(2000))

    // case7:
    // 0. USDC = token0, ETH = token1
    // 1. USDC -> ETH => isBaseToQuote = false
    // 2. exact 2000 USDC => isExactInput = true
    // - isZeroForOne = true
    // - amountWithSignDigit = 2000
    // ---------------------------------------
    // amount0 = 2000
    // amount1 = -x
    // deltaAmount = -(-x)
    // response.quote = -(-x)
    // response.base = amount = 2000
})
