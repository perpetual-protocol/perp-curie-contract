import { keccak256 } from "@ethersproject/solidity"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse removeLiquidity without fee", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let vault: Vault
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let baseAmount: BigNumber
    let quoteAmount: BigNumber

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
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
            await clearingHouse.addPool(baseToken.address, 10000)

            // mint
            await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
            await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
            await clearingHouse.connect(bob).mint(baseToken.address, baseAmount)
            await clearingHouse.connect(bob).mint(quoteToken.address, quoteAmount)
            await clearingHouse.connect(carol).mint(baseToken.address, baseAmount)
            await clearingHouse.connect(carol).mint(quoteToken.address, quoteAmount)

            const baseBefore = await baseToken.balanceOf(clearingHouse.address)
            const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

            // assume imRatio = 0.1
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
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

            const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400))
                .liquidity

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
                .to.emit(clearingHouse, "LiquidityChanged")
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
            expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                BigNumber.from("99999999999999999999"), // available
                parseUnits("100", await baseToken.decimals()), // debt
            ])
            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                parseUnits("10000", await quoteToken.decimals()), // available
                parseUnits("10000", await quoteToken.decimals()), // debt
            ])
            expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
            expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).to.deep.eq([
                BigNumber.from(0), // liquidity
                0, // lowerTick
                0, // upperTick
                parseUnits("0", await baseToken.decimals()), // feeGrowthInsideClearingHouseLastX128
                parseUnits("0", await quoteToken.decimals()), // feeGrowthInsideUniswapLastX128
            ])

            // verify CH balance changes
            // TODO somehow Alice receives 1 wei less than she deposited, it could be a problem for closing positions
            expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(1)
            expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(quoteBefore)
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
                await clearingHouse.addPool(baseToken.address, 10000)

                // mint
                await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
                await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
                await clearingHouse.connect(bob).mint(baseToken.address, baseAmount)
                await clearingHouse.connect(bob).mint(quoteToken.address, quoteAmount)
                await clearingHouse.connect(carol).mint(baseToken.address, baseAmount)
                await clearingHouse.connect(carol).mint(quoteToken.address, quoteAmount)
            })

            it("below current price", async () => {
                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
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

                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50200))
                    .liquidity

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
                    .to.emit(clearingHouse, "LiquidityChanged")
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
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    parseUnits("100", await baseToken.decimals()), // available
                    parseUnits("100", await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    BigNumber.from("9999999999999999999999"), // available, ~= -10,000
                    parseUnits("10000", await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50200)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // feeGrowthInsideClearingHouseLastX128
                    parseUnits("0", await quoteToken.decimals()), // feeGrowthInsideUniswapLastX128
                ])

                // verify CH balance changes
                expect(await baseToken.balanceOf(clearingHouse.address)).to.eq(baseBefore)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(1)
            })

            it("at current price", async () => {
                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

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

                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

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
                    .to.emit(clearingHouse, "LiquidityChanged")
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
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    BigNumber.from("99999999999999999999"), // available
                    parseUnits("100", await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    BigNumber.from("9999999999999999999999"), // available
                    parseUnits("10000", await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // feeGrowthInsideClearingHouseLastX128
                    parseUnits("0", await quoteToken.decimals()), // feeGrowthInsideUniswapLastX128
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(1)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(1)
            })

            it("twice", async () => {
                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

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

                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                const firstRemoveLiquidity = liquidity.div(2)
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
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    BigNumber.from("99999999999999999999"), // available, ~= 100
                    parseUnits("100", await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    BigNumber.from("9999999999999999999999"), // available ~= 10,000
                    parseUnits("10000", await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // feeGrowthInsideClearingHouseLastX128
                    parseUnits("0", await quoteToken.decimals()), // feeGrowthInsideUniswapLastX128
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(1)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(1)
            })

            it("force error, remove too much liquidity", async () => {
                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

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
                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
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
                ).to.be.revertedWith("CH_NEL")
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
                ).to.be.revertedWith("CH_NEO")
            })
        })
    })

    it("remove zero liquidity; no swap no fee", async () => {
        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)
        // add pool after it's initialized
        await clearingHouse.addPool(baseToken.address, 10000)

        // mint
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)

        const baseBefore = await baseToken.balanceOf(clearingHouse.address)
        const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

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
        const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).liquidity

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
            .to.emit(clearingHouse, "LiquidityChanged")
            .withArgs(alice.address, baseToken.address, quoteToken.address, 50000, 50400, 0, 0, 0, 0)

        // verify account states
        expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
            BigNumber.from("33938154569530515977"), // available
            parseUnits("100", await baseToken.decimals()), // debt
        ])
        expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
            BigNumber.from(0), // available
            parseUnits("10000", await quoteToken.decimals()), // debt
        ])
        expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.deep.eq([
            keccak256(["address", "address", "int24", "int24"], [alice.address, baseToken.address, 50000, 50400]),
        ])
        expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
            liquidity,
            50000, // lowerTick
            50400, // upperTick
            parseUnits("0", await baseToken.decimals()), // feeGrowthInsideClearingHouseLastX128
            parseUnits("0", await quoteToken.decimals()), // feeGrowthInsideUniswapLastX128
        ])

        // verify CH balance changes
        expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
            BigNumber.from("66061845430469484023"),
        )
        expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
            parseUnits("10000", await quoteToken.decimals()),
        )
    })
})
