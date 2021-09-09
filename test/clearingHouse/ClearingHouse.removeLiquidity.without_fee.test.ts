import { keccak256 } from "@ethersproject/solidity"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, Exchange, TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse removeLiquidity without fee", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let baseAmount: BigNumber
    let quoteAmount: BigNumber

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()
        baseAmount = parseUnits("100", await baseToken.decimals())
        quoteAmount = parseUnits("10000", await quoteToken.decimals())

        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)

        // prepare collateral for bob
        await collateral.transfer(bob.address, amount)
        await deposit(bob, vault, 1000, collateral)

        // prepare collateral for carol
        await collateral.transfer(carol.address, amount)
        await deposit(carol, vault, 1000, collateral)
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("remove non-zero liquidity", () => {
        // @SAMPLE - removeLiquidity
        it("above current price", async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)
            // add pool after it's initialized
            await exchange.addPool(baseToken.address, 10000)

            // assume imRatio = 0.1
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
            // will mint 100 base -> transfer to pool
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: 0,
                lowerTick: 50200,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            const liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).liquidity

            // will receive 100 base from pool
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50200,
                    upperTick: 50400,
                    liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(exchange, "LiquidityChanged")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    quoteToken.address,
                    50200,
                    50400,
                    "-99999999999999999999",
                    0,
                    "-123656206035422669342231",
                    0,
                )

            // WIP verify account states
            // TODO somehow Alice receives 1 wei less than she deposited, it seems to be an artifact of uniswapV3Pool.mint/burn()
            //  however, the actual number of tokens sent/received are matched
            const [baseTokenInfo, quoteTokenInfo] = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            expect(baseTokenInfo.balance).to.deep.eq(BigNumber.from(-1))
            expect(quoteTokenInfo.balance).to.deep.eq(parseUnits("0", await quoteToken.decimals()))

            expect(await exchange.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
            const openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            expect(openOrder).to.deep.eq([
                BigNumber.from(0), // liquidity
                0, // lowerTick
                0, // upperTick
                parseUnits("0", await baseToken.decimals()), // feeGrowthInsideLastBase
                openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
            ])
        })

        it("force error, pool does not exist", async () => {
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: collateral.address, // can't use quote token because _settleFunding would revert first
                    lowerTick: 0,
                    upperTick: 200,
                    liquidity: BigNumber.from(1),
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.be.revertedWith("CH_BTNE")
        })

        describe("initialized price = 151.373306858723226652", () => {
            beforeEach(async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                // add pool after it's initialized
                await exchange.addPool(baseToken.address, 10000)
            })

            it("below current price", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                // will mint 10000 quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50200,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                const liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50200))
                    .liquidity

                // will receive 10000 quote from pool
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50200,
                        liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(exchange, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        "-9999999999999999999999", // ~= -10,000
                        "-81689571696303801037492",
                        0,
                    )

                // verify account states
                const [baseTokenInfo, quoteTokenInfo] = await clearingHouse.getTokenInfo(
                    alice.address,
                    baseToken.address,
                )
                expect(baseTokenInfo.balance).to.deep.eq(parseUnits("0", await baseToken.decimals()))
                // TODO somehow Alice receives 1 wei less than she deposited, it seems to be an artifact of uniswapV3Pool.mint/burn()
                //  however, the actual number of tokens sent/received are matched
                expect(quoteTokenInfo.balance).to.deep.eq(BigNumber.from("-1"))

                expect(await exchange.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                const openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50200)
                expect(openOrder).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // feeGrowthInsideLastBase
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])
            })

            it("at current price", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                // will mint x base and y quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                const liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                // will receive x base and y quote from pool
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(exchange, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        parseUnits("-66.061845430469484022", await baseToken.decimals()),
                        "-9999999999999999999999",
                        "-81689571696303801018159",
                        0,
                    )

                // verify account states
                // TODO somehow Alice receives 1 wei less than she deposited, it seems to be an artifact of uniswapV3Pool.mint/burn()
                //  however, the actual number of tokens sent/received are matched
                const [baseTokenInfo, quoteTokenInfo] = await clearingHouse.getTokenInfo(
                    alice.address,
                    baseToken.address,
                )
                expect(baseTokenInfo.balance).to.deep.eq(BigNumber.from("-1"))
                expect(quoteTokenInfo.balance).to.deep.eq(BigNumber.from("-1"))

                expect(await exchange.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                const openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // feeGrowthInsideLastBase
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])
            })

            it("twice", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                // will mint x base and y quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                const liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                const firstRemoveLiquidity = liquidity.div(2)
                // will receive x/2 base and y/2 quote from pool
                await clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: firstRemoveLiquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                const secondRemoveLiquidity = liquidity.sub(firstRemoveLiquidity)
                // will receive x/2 base and y/2 quote from pool
                await clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: secondRemoveLiquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // verify account states
                // TODO somehow Alice receives 1 wei less than she deposited, it seems to be an artifact of uniswapV3Pool.mint/burn()
                //  however, the actual number of tokens sent/received are matched
                const [baseTokenInfo, quoteTokenInfo] = await clearingHouse.getTokenInfo(
                    alice.address,
                    baseToken.address,
                )
                expect(baseTokenInfo.balance).to.deep.eq(BigNumber.from("-1"))
                expect(quoteTokenInfo.balance).to.deep.eq(BigNumber.from("-1"))

                expect(await exchange.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                const openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // feeGrowthInsideLastBase
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])
            })

            it("force error, remove too much liquidity", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
                const liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: liquidity.add(1),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("EX_NEL")
            })

            it("force error, range does not exist", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50200,
                        liquidity: BigNumber.from(1),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("EX_NEO")
            })
        })
    })

    it("remove zero liquidity; no swap no fee", async () => {
        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)
        // add pool after it's initialized
        await exchange.addPool(baseToken.address, 10000)

        // assume imRatio = 0.1
        // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
        // will mint x base and y quote and transfer to pool
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseUnits("100", await baseToken.decimals()),
            quote: parseUnits("10000", await quoteToken.decimals()),
            lowerTick: 50000,
            upperTick: 50400,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        const liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).liquidity

        // will receive no tokens from pool (no fees)
        await expect(
            clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 50000,
                upperTick: 50400,
                liquidity: 0,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }),
        )
            .to.emit(exchange, "LiquidityChanged")
            .withArgs(alice.address, baseToken.address, quoteToken.address, 50000, 50400, 0, 0, 0, 0)

        // verify account states
        // alice should have 100 - 33.9381545695 = 66.0618454305 debt
        const [baseTokenInfo, quoteTokenInfo] = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
        expect(baseTokenInfo.balance).to.deep.eq(parseUnits("-66.061845430469484023", await baseToken.decimals()))
        expect(quoteTokenInfo.balance).to.deep.eq(parseUnits("-10000", await quoteToken.decimals()))

        expect(await exchange.getOpenOrderIds(alice.address, baseToken.address)).to.deep.eq([
            keccak256(["address", "address", "int24", "int24"], [alice.address, baseToken.address, 50000, 50400]),
        ])
        const openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
        expect(openOrder).to.deep.eq([
            liquidity,
            50000, // lowerTick
            50400, // upperTick
            parseUnits("0", await baseToken.decimals()), // feeGrowthInsideLastBase
            openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
            openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
            openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
        ])
    })
})
