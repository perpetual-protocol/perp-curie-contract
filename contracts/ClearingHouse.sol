// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { Validation } from "./base/Validation.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { IVault } from "./interface/IVault.sol";
import { Exchange } from "./Exchange.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";
import { OrderBook } from "./OrderBook.sol";
import { ClearingHouseConfig } from "./ClearingHouseConfig.sol";
import { AccountBalance } from "./AccountBalance.sol";

contract ClearingHouse is
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback,
    ReentrancyGuardUpgradeable,
    Validation,
    OwnerPausable,
    BaseRelayRecipient
{
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;
    using SafeMathUpgradeable for uint160;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using SignedSafeMathUpgradeable for int256;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using AccountMarket for AccountMarket.Info;

    //
    // STRUCT
    //

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    /// @param liquidity collect fee when 0
    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    struct InternalRemoveLiquidityParams {
        address maker;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct RemoveLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint256 liquidity;
    }

    /// @param sqrtPriceLimitX96 for price slippage protection
    struct InternalSwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96;
        Funding.Growth fundingGrowthGlobal;
    }

    struct SwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        int256 openNotional;
        int256 realizedPnl;
        int24 tick;
    }

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        // when it's 0 in exactInput, means ignore slippage protection
        // when it's maxUint in exactOutput = ignore
        // when it's over or under the bound, it will be reverted
        uint256 oppositeAmountBound;
        uint256 deadline;
        // B2Q: the price cannot be less than this value after the swap
        // Q2B: The price cannot be greater than this value after the swap
        // it will fill the trade until it reach the price limit instead of reverted
        uint160 sqrtPriceLimitX96;
        bytes32 referralCode;
    }

    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool skipMarginRequirementCheck;
        Funding.Growth fundingGrowthGlobal;
    }

    struct AfterRemoveLiquidityParams {
        address maker;
        address baseToken;
        uint256 removedBase;
        uint256 removedQuote;
        uint256 collectedFee;
    }

    struct ClosePositionParams {
        address baseToken;
        uint160 sqrtPriceLimitX96;
        uint256 oppositeAmountBound;
        uint256 deadline;
        bytes32 referralCode;
    }

    struct InternalClosePositionParams {
        address trader;
        address baseToken;
        uint160 sqrtPriceLimitX96;
        Funding.Growth fundingGrowthGlobal;
    }

    struct CheckSlippageParams {
        bool isBaseToQuote;
        bool isExactInput;
        uint256 deltaAvailableQuote;
        uint256 deltaAvailableBase;
        uint256 oppositeAmountBound;
    }

    //
    // STATE
    //

    // --------- IMMUTABLE ---------

    address public quoteToken;
    address public uniswapV3Factory;

    // cache the settlement token's decimals for gas optimization
    uint8 internal _settlementTokenDecimals;

    // --------- ^^^^^^^^^ ---------

    // not used in CH, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    address public clearingHouseConfig;
    address public vault;
    address public insuranceFund;
    address public exchange;
    address public orderBook;
    address public accountBalance;

    // first key: trader, second key: baseToken
    // value: the last timestamp when a trader exceeds price limit when closing a position/being liquidated
    mapping(address => mapping(address => uint256)) internal _lastOverPriceLimitTimestampMap;

    // TODO move to exchange
    // key: base token
    // value: a threshold to limit the price impact per block when reducing or closing the position
    mapping(address => uint24) private _maxTickCrossedWithinBlockMap;

    //
    // EVENT
    //

    event PositionChanged(
        address indexed trader,
        address indexed baseToken,
        int256 exchangedPositionSize,
        int256 exchangedPositionNotional,
        uint256 fee,
        int256 openNotional,
        int256 realizedPnl
    );
    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );
    event ReferredPositionChanged(bytes32 indexed referralCode);

    //
    // MODIFIER
    //

    modifier onlyExchange() {
        // only exchange
        require(_msgSender() == exchange, "CH_OE");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    /// @dev this function is public for testing
    function initialize(
        address clearingHouseConfigArg,
        address vaultArg,
        address insuranceFundArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        address exchangeArg,
        address accountBalanceArg
    ) public initializer {
        // CH_VANC: Vault address is not contract
        require(vaultArg.isContract(), "CH_VANC");
        // CH_IFANC: InsuranceFund address is not contract
        require(insuranceFundArg.isContract(), "CH_IFANC");

        // TODO check QuoteToken's balance once this is upgradable
        // CH_QANC: QuoteToken address is not contract
        require(quoteTokenArg.isContract(), "CH_QANC");
        // CH_QDN18: QuoteToken decimals is not 18
        require(IERC20Metadata(quoteTokenArg).decimals() == 18, "CH_QDN18");
        // CH_UANC: UniV3Factory address is not contract
        require(uniV3FactoryArg.isContract(), "CH_UANC");
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "CH_CCNC");
        // AccountBalance is not contract
        require(accountBalanceArg.isContract(), "CH_ABNC");

        // CH_ANC: address is not contract
        require(exchangeArg.isContract(), "CH_ANC");

        address orderBookArg = Exchange(exchangeArg).orderBook();

        // orderbook is not contarct
        require(orderBookArg.isContract(), "CH_OBNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        clearingHouseConfig = clearingHouseConfigArg;
        vault = vaultArg;
        insuranceFund = insuranceFundArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
        exchange = exchangeArg;
        orderBook = orderBookArg;
        accountBalance = accountBalanceArg;

        _settlementTokenDecimals = IVault(vault).decimals();

        // we don't use this var
        versionRecipient = "2.0.0";
    }

    // solhint-disable-next-line
    function setMaxTickCrossedWithinBlock(address baseToken, uint24 maxTickCrossedWithinBlock) external onlyOwner {
        // CH_ANC: address is not contract
        require(baseToken.isContract(), "CH_ANC");

        _requireHasBaseToken(baseToken);

        // CH_MTO: max tick crossed limit out of range
        // tick range is [-MAX_TICK, MAX_TICK], maxTickCrossedWithinBlock should be in [0, MAX_TICK]
        require(maxTickCrossedWithinBlock <= uint24(TickMath.MAX_TICK), "CH_MTCLOOR");

        _maxTickCrossedWithinBlockMap[baseToken] = maxTickCrossedWithinBlock;
    }

    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // CH_ANC: address is not contract
        require(trustedForwarderArg.isContract(), "CH_ANC");
        _setTrustedForwarder(trustedForwarderArg);
    }

    function addLiquidity(AddLiquidityParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (AddLiquidityResponse memory)
    {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();
        // register token if it's the first time
        AccountBalance(accountBalance).registerBaseToken(trader, params.baseToken);

        Funding.Growth memory fundingGrowthGlobal =
            AccountBalance(accountBalance).settleFundingAndUpdateFundingGrowth(trader, params.baseToken);

        // note that we no longer check available tokens here because CH will always auto-mint
        // when requested by UniswapV3MintCallback
        OrderBook.AddLiquidityResponse memory response =
            OrderBook(orderBook).addLiquidity(
                OrderBook.AddLiquidityParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    base: params.base,
                    quote: params.quote,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );
        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        // collect fee to owedRealizedPnl
        AccountBalance(accountBalance).addBalance(
            trader,
            params.baseToken,
            -(response.base.toInt256()),
            -(response.quote.toInt256()),
            response.fee.toInt256()
        );

        // TODO : WIP
        // must after token info is updated to ensure free collateral is positive after updated
        _requireEnoughFreeCollateral(trader);

        return
            AddLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: response.fee,
                liquidity: response.liquidity
            });
    }

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (RemoveLiquidityResponse memory response)
    {
        _requireHasBaseToken(params.baseToken);
        response = _removeLiquidity(
            InternalRemoveLiquidityParams({
                maker: _msgSender(),
                baseToken: params.baseToken,
                lowerTick: params.lowerTick,
                upperTick: params.upperTick,
                liquidity: params.liquidity
            })
        );

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");
    }

    function openPosition(OpenPositionParams memory params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        address trader = _msgSender();

        _requireHasBaseToken(params.baseToken);
        AccountBalance(accountBalance).registerBaseToken(trader, params.baseToken);

        // must before price impact check
        Funding.Growth memory fundingGrowthGlobal =
            AccountBalance(accountBalance).settleFundingAndUpdateFundingGrowth(trader, params.baseToken);

        // cache before actual swap
        bool isReducePosition = !_isIncreasePosition(trader, params.baseToken, params.isBaseToQuote);
        if (isReducePosition) {
            // revert if current price isOverPriceLimit before open position
            // CH_OPIBS: over price impact before swap
            require(!_isOverPriceLimit(params.baseToken, Exchange(exchange).getTick(params.baseToken)), "CH_OPIBS");
        }

        Exchange.SwapResponse memory response =
            _openPosition(
                InternalOpenPositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: false,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        if (isReducePosition) {
            // revert if isOverPriceLimit to avoid that partially closing a position in openPosition() seems unexpected
            // CH_OPIAS: over price impact after swap
            require(!_isOverPriceLimit(params.baseToken, response.tick), "CH_OPIAS");
        }

        _checkSlippage(
            CheckSlippageParams({
                isBaseToQuote: params.isBaseToQuote,
                isExactInput: params.isExactInput,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    function closePosition(ClosePositionParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();
        Funding.Growth memory fundingGrowthGlobal =
            AccountBalance(accountBalance).settleFundingAndUpdateFundingGrowth(trader, params.baseToken);

        Exchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // if the previous position is long, closing it is short, B2Q; else, closing it is long, Q2B
        bool isBaseToQuote =
            AccountBalance(accountBalance).getPositionSize(trader, params.baseToken) > 0 ? true : false;
        _checkSlippage(
            CheckSlippageParams({
                isBaseToQuote: isBaseToQuote,
                isExactInput: true,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    function liquidate(address trader, address baseToken) external whenNotPaused nonReentrant {
        _requireHasBaseToken(baseToken);
        // per liquidation specs:
        //   https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1
        //
        // liquidation trigger:
        //   accountMarginRatio < accountMaintenanceMarginRatio
        //   => accountValue / sum(abs(positionValue_market)) <
        //        sum(mmRatio * abs(positionValue_market)) / sum(abs(positionValue_market))
        //   => accountValue < sum(mmRatio * abs(positionValue_market))
        //   => accountValue < sum(abs(positionValue_market)) * mmRatio = totalMinimumMarginRequirement
        //
        // CH_EAV: enough account value
        require(
            getAccountValue(trader).lt(
                AccountBalance(accountBalance)
                    .getTotalAbsPositionValue(trader)
                    .mulRatio(ClearingHouseConfig(clearingHouseConfig).mmRatio())
                    .toInt256(),
                _settlementTokenDecimals
            ),
            "CH_EAV"
        );

        // CH_NEO: not empty order
        require(!AccountBalance(accountBalance).hasOrder(trader), "CH_NEO");

        Funding.Growth memory fundingGrowthGlobal =
            AccountBalance(accountBalance).settleFundingAndUpdateFundingGrowth(trader, baseToken);
        Exchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: baseToken,
                    sqrtPriceLimitX96: 0,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // trader's pnl-- as liquidation penalty
        uint256 liquidationFee =
            response.exchangedPositionNotional.abs().mulRatio(
                ClearingHouseConfig(clearingHouseConfig).liquidationPenaltyRatio()
            );

        AccountBalance(accountBalance).addOwedRealizedPnl(trader, -(liquidationFee.toInt256()));

        // increase liquidator's pnl liquidation reward
        address liquidator = _msgSender();
        AccountBalance(accountBalance).addOwedRealizedPnl(liquidator, liquidationFee.toInt256());

        emit PositionLiquidated(
            trader,
            baseToken,
            response.exchangedPositionNotional.abs(),
            response.deltaAvailableBase,
            liquidationFee,
            liquidator
        );
    }

    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external whenNotPaused nonReentrant {
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    function cancelAllExcessOrders(address maker, address baseToken) external whenNotPaused nonReentrant {
        bytes32[] memory orderIds = OrderBook(orderBook).getOpenOrderIds(maker, baseToken);
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        // not orderBook
        require(_msgSender() == orderBook, "CH_NOB");

        OrderBook.MintCallbackData memory callbackData = abi.decode(data, (OrderBook.MintCallbackData));

        if (amount0Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token0();
            IERC20Metadata(token).transfer(callbackData.pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token1();
            IERC20Metadata(token).transfer(callbackData.pool, amount1Owed);
        }
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override onlyExchange {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        Exchange.SwapCallbackData memory callbackData = abi.decode(data, (Exchange.SwapCallbackData));
        IUniswapV3Pool uniswapV3Pool = IUniswapV3Pool(callbackData.pool);

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0
                ? (uniswapV3Pool.token0(), uint256(amount0Delta))
                : (uniswapV3Pool.token1(), uint256(amount1Delta));

        // swap
        IERC20Metadata(token).transfer(address(callbackData.pool), amountToPay);
    }

    //
    // EXTERNAL VIEW
    //

    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24) {
        return _maxTickCrossedWithinBlockMap[baseToken];
    }

    /// @dev accountValue = totalCollateralValue + totalUnrealizedPnl, in the settlement token's decimals
    function getAccountValue(address trader) public view returns (int256) {
        return
            _getTotalCollateralValue(trader).addS(
                AccountBalance(accountBalance).getTotalUnrealizedPnl(trader),
                _settlementTokenDecimals
            );
    }

    /// @dev the amount of quote token paid for a position when opening
    function getOpenNotional(address trader, address baseToken) public view returns (int256) {
        // quote.pool[baseToken] + quote.owedFee[baseToken] + quoteBalance[baseToken]
        // https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1

        return Exchange(exchange).getOpenNotional(trader, baseToken);
    }

    // INTERNAL NON-VIEW
    //

    function _cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] memory orderIds
    ) internal {
        _requireHasBaseToken(baseToken);

        // CH_NEFCM: not enough free collateral by mmRatio
        // only cancel open orders if there are not enough free collateral with mmRatio
        require(_getFreeCollateralByRatio(maker, ClearingHouseConfig(clearingHouseConfig).mmRatio()) < 0, "CH_NEFCM");

        // must settle funding before getting token info
        AccountBalance(accountBalance).settleFundingAndUpdateFundingGrowth(maker, baseToken);
        OrderBook.RemoveLiquidityResponse memory response =
            OrderBook(orderBook).removeLiquidityByIds(maker, baseToken, orderIds);
        _afterRemoveLiquidity(
            AfterRemoveLiquidityParams({
                maker: maker,
                baseToken: baseToken,
                removedBase: response.base,
                removedQuote: response.quote,
                collectedFee: response.fee
            })
        );
    }

    function _afterRemoveLiquidity(AfterRemoveLiquidityParams memory params) internal {
        // collect fee to owedRealizedPnl
        AccountBalance(accountBalance).addBalance(
            params.maker,
            params.baseToken,
            params.removedBase.toInt256(),
            params.removedQuote.toInt256(),
            params.collectedFee.toInt256()
        );
        AccountBalance(accountBalance).deregisterBaseToken(params.maker, params.baseToken);
    }

    function _removeLiquidity(InternalRemoveLiquidityParams memory params)
        internal
        returns (RemoveLiquidityResponse memory)
    {
        // must settle funding before getting token info
        AccountBalance(accountBalance).settleFundingAndUpdateFundingGrowth(params.maker, params.baseToken);
        OrderBook.RemoveLiquidityResponse memory response =
            OrderBook(orderBook).removeLiquidity(
                OrderBook.RemoveLiquidityParams({
                    maker: params.maker,
                    baseToken: params.baseToken,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );
        _afterRemoveLiquidity(
            AfterRemoveLiquidityParams({
                maker: params.maker,
                baseToken: params.baseToken,
                removedBase: response.base,
                removedQuote: response.quote,
                collectedFee: response.fee
            })
        );
        return RemoveLiquidityResponse({ quote: response.quote, base: response.base, fee: response.fee });
    }

    /// @dev explainer diagram for the relationship between exchangedPositionNotional, fee and openNotional:
    ///      https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events
    function _openPosition(InternalOpenPositionParams memory params) internal returns (Exchange.SwapResponse memory) {
        Exchange.SwapResponse memory response =
            Exchange(exchange).swapAndCalculateOpenNotional(
                Exchange.SwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: params.fundingGrowthGlobal
                })
            );

        if (!params.skipMarginRequirementCheck) {
            // it's not closing the position, check margin ratio
            _requireEnoughFreeCollateral(params.trader);
        }

        AccountBalance(accountBalance).addOwedRealizedPnl(insuranceFund, response.insuranceFundFee.toInt256());
        AccountBalance(accountBalance).deregisterBaseToken(params.trader, params.baseToken);

        emit PositionChanged(
            params.trader,
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional,
            response.fee,
            response.openNotional,
            response.realizedPnl
        );

        return response;
    }

    function _closePosition(InternalClosePositionParams memory params) internal returns (Exchange.SwapResponse memory) {
        int256 positionSize = AccountBalance(accountBalance).getPositionSize(params.trader, params.baseToken);

        // CH_PSZ: position size is zero
        require(positionSize != 0, "CH_PSZ");

        // if trader is on long side, baseToQuote: true, exactInput: true
        // if trader is on short side, baseToQuote: false (quoteToBase), exactInput: false (exactOutput)
        bool isLong = positionSize > 0 ? true : false;

        Exchange.ReplaySwapParams memory replaySwapParams =
            Exchange.ReplaySwapParams({
                baseToken: params.baseToken,
                isBaseToQuote: isLong,
                isExactInput: isLong,
                amount: positionSize.abs(),
                sqrtPriceLimitX96: _getSqrtPriceLimit(params.baseToken, !isLong)
            });

        // simulate the tx to see if it isOverPriceLimit; if true, can partially close the position only once
        // replaySwap: the given sqrtPriceLimitX96 is corresponding max tick + 1 or min tick - 1,
        uint24 partialCloseRatio = ClearingHouseConfig(clearingHouseConfig).partialCloseRatio();
        if (
            _isOverPriceLimit(params.baseToken, Exchange(exchange).getTick(params.baseToken)) ||
            _isOverPriceLimit(params.baseToken, Exchange(exchange).replaySwap(replaySwapParams))
        ) {
            // CH_AOPLO: already over price limit once
            require(_blockTimestamp() != _lastOverPriceLimitTimestampMap[params.trader][params.baseToken], "CH_AOPLO");
            _lastOverPriceLimitTimestampMap[params.trader][params.baseToken] = _blockTimestamp();
            replaySwapParams.amount = replaySwapParams.amount.mulRatio(partialCloseRatio);
        }

        return
            _openPosition(
                InternalOpenPositionParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: replaySwapParams.isBaseToQuote,
                    isExactInput: replaySwapParams.isExactInput,
                    amount: replaySwapParams.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: true,
                    fundingGrowthGlobal: params.fundingGrowthGlobal
                })
            );
    }

    //
    // INTERNAL VIEW
    //

    function _isOverPriceLimit(address baseToken, int24 tick) internal view returns (bool) {
        uint24 maxTickDelta = _maxTickCrossedWithinBlockMap[baseToken];
        if (maxTickDelta == 0) {
            return false;
        }
        int24 lastUpdatedTick = Exchange(exchange).getLastUpdatedTick(baseToken);
        // no overflow/underflow issue because there are range limits for tick and maxTickDelta
        int24 upperTickBound = lastUpdatedTick + int24(maxTickDelta);
        int24 lowerTickBound = lastUpdatedTick - int24(maxTickDelta);
        return (tick < lowerTickBound || tick > upperTickBound);
    }

    function _getSqrtPriceLimit(address baseToken, bool isLong) internal view returns (uint160) {
        int24 lastUpdatedTick = Exchange(exchange).getLastUpdatedTick(baseToken);
        uint24 maxTickDelta = _maxTickCrossedWithinBlockMap[baseToken];
        int24 tickBoundary =
            isLong ? lastUpdatedTick + int24(maxTickDelta) + 1 : lastUpdatedTick - int24(maxTickDelta) - 1;
        return TickMath.getSqrtRatioAtTick(tickBoundary);
    }

    /// @dev the return value is in settlement token decimals
    function _getTotalCollateralValue(address trader) internal view returns (int256) {
        int256 owedRealizedPnl = AccountBalance(accountBalance).getOwedRealizedPnlWithPendingFundingPayment(trader);
        return IVault(vault).balanceOf(trader).addS(owedRealizedPnl, _settlementTokenDecimals);
    }

    function _isIncreasePosition(
        address trader,
        address baseToken,
        bool isBaseToQuote
    ) internal view returns (bool) {
        // increase position == old/new position are in the same direction
        int256 positionSize = AccountBalance(accountBalance).getPositionSize(trader, baseToken);
        bool isOldPositionShort = positionSize < 0 ? true : false;
        return (positionSize == 0 || isOldPositionShort == isBaseToQuote);
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, OwnerPausable) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, OwnerPausable) returns (bytes memory) {
        return super._msgData();
    }

    // TODO remove, should check in exchange
    function _requireHasBaseToken(address baseToken) internal view {
        // CH_BTNE: base token not exists
        require(Exchange(exchange).getPool(baseToken) != address(0), "CH_BTNE");
    }

    function _getFreeCollateralByRatio(address trader, uint24 ratio) internal view returns (int256) {
        return IVault(vault).getFreeCollateralByRatio(trader, ratio);
    }

    function _requireEnoughFreeCollateral(address trader) internal view {
        // CH_NEFCI: not enough account value by imRatio
        // freeCollateral is calculated with imRatio
        require(_getFreeCollateralByRatio(trader, ClearingHouseConfig(clearingHouseConfig).imRatio()) >= 0, "CH_NEFCI");
    }

    function _checkSlippage(CheckSlippageParams memory params) internal pure {
        // skip when params.oppositeAmountBound is zero
        if (params.oppositeAmountBound == 0) {
            return;
        }

        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        if (params.isBaseToQuote) {
            if (params.isExactInput) {
                // too little received
                require(params.deltaAvailableQuote >= params.oppositeAmountBound, "CH_TLR");
            } else {
                // too much requested
                require(params.deltaAvailableBase <= params.oppositeAmountBound, "CH_TMR");
            }
        } else {
            if (params.isExactInput) {
                // too little received
                require(params.deltaAvailableBase >= params.oppositeAmountBound, "CH_TLR");
            } else {
                // too much requested
                require(params.deltaAvailableQuote <= params.oppositeAmountBound, "CH_TMR");
            }
        }
    }
}
