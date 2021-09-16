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
import { ISettlement } from "./interface/ISettlement.sol";
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
    ISettlement,
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
    // events
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
    // Struct
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

    struct InternalSwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
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

    // not used in CH, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    //
    // state variables
    //

    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    address public quoteToken;
    address public uniswapV3Factory;

    address public config;
    address public vault;
    address public insuranceFund;
    address public exchange;
    address public orderBook;
    address public accountBalance;

    // cached the settlement token's decimal for gas optimization
    // owner must ensure the settlement token's decimal is not immutable
    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    uint8 internal _settlementTokenDecimals;

    // first key: trader, second key: baseToken
    // value: the last timestamp when a trader exceeds price limit when closing a position/being liquidated
    mapping(address => mapping(address => uint256)) internal _lastOverPriceLimitTimestampMap;

    // TODO move to exchange
    // key: base token
    // value: a threshold to limit the price impact per block when reducing or closing the position
    mapping(address => uint24) private _maxTickCrossedWithinBlockMap;

    function initialize(
        address configArg,
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
        require(configArg.isContract(), "CH_CCNC");
        // AccountBalance is not contract
        require(accountBalanceArg.isContract(), "CH_ABNC");

        // CH_ANC: address is not contract
        require(exchangeArg.isContract(), "CH_ANC");

        address orderBookArg = Exchange(exchangeArg).orderBook();

        // orderbook is not contarct
        require(orderBookArg.isContract(), "CH_OBNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        config = configArg;
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

    //
    // MODIFIER
    //
    modifier onlyExchange() {
        // only exchange
        require(_msgSender() == exchange, "CH_OE");
        _;
    }

    //
    // EXTERNAL ADMIN FUNCTIONS
    //

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

    //
    // EXTERNAL ONLY EXCHANGE
    //
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
            TransferHelper.safeTransfer(token, callbackData.pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token1();
            TransferHelper.safeTransfer(token, callbackData.pool, amount1Owed);
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
        TransferHelper.safeTransfer(token, address(callbackData.pool), amountToPay);
    }

    //
    // EXTERNAL FUNCTIONS
    //
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

        // update token info
        // TODO should burn base fee received instead of adding it to available amount

        // collect fee to owedRealizedPnl
        AccountBalance(accountBalance).addOwedRealizedPnl(trader, response.fee.toInt256());

        _addBase(trader, params.baseToken, -(response.base.toInt256()));
        _addQuote(trader, params.baseToken, -(response.quote.toInt256()));

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

        SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // TODO scale up or down the opposite amount bound if it's a partial close
        // if oldPositionSize is long, close a long position is short, B2Q
        // if oldPositionSize is short, close a short position is long, Q2B
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

        SwapResponse memory response =
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
                    .mulRatio(ClearingHouseConfig(config).mmRatio())
                    .toInt256(),
                _settlementTokenDecimals
            ),
            "CH_EAV"
        );

        // CH_NEO: not empty order
        require(!AccountBalance(accountBalance).hasOrder(trader), "CH_NEO");

        Funding.Growth memory fundingGrowthGlobal =
            AccountBalance(accountBalance).settleFundingAndUpdateFundingGrowth(trader, baseToken);
        SwapResponse memory response =
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
            response.exchangedPositionNotional.abs().mulRatio(ClearingHouseConfig(config).liquidationPenaltyRatio());

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

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24) {
        return _maxTickCrossedWithinBlockMap[baseToken];
    }

    // return in settlement token decimals
    function getAccountValue(address trader) public view returns (int256) {
        int256 totalUnrealizedPnl = AccountBalance(accountBalance).getTotalUnrealizedPnl(trader);
        return _getTotalCollateralValue(trader).addS(totalUnrealizedPnl, _settlementTokenDecimals);
    }

    // TODO remove?
    /// @dev a negative returned value is only be used when calculating pnl
    function getPositionValue(address trader, address baseToken) external view returns (int256) {
        return AccountBalance(accountBalance).getPositionValue(trader, baseToken);
    }

    /// @dev the amount of quote token paid for a position when opening
    function getOpenNotional(address trader, address baseToken) public view returns (int256) {
        // quote.pool[baseToken] + quote.owedFee[baseToken] + quoteBalance[baseToken]
        // https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1

        int256 openNotional =
            OrderBook(orderBook).getTotalTokenAmountInPool(trader, baseToken, false).toInt256().add(
                _getQuote(trader, baseToken)
            );

        return openNotional;
    }

    /// @dev the decimals of the return value is 18
    function getTotalInitialMarginRequirement(address trader) external view returns (uint256) {
        return _getTotalInitialMarginRequirement(trader);
    }

    //
    // INTERNAL FUNCTIONS
    //

    function _cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] memory orderIds
    ) internal {
        _requireHasBaseToken(baseToken);

        // CH_EFC: enough free collateral
        // only cancel open orders if there are not enough free collateral
        require(_getFreeCollateral(maker) < 0, "CH_EFC");

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
        AccountBalance(accountBalance).addOwedRealizedPnl(params.maker, params.collectedFee.toInt256());

        _addQuote(params.maker, params.baseToken, params.removedQuote.toInt256());
        _addBase(params.maker, params.baseToken, params.removedBase.toInt256());

        AccountBalance(accountBalance).deregisterBaseToken(params.maker, params.baseToken);
    }

    // TODO refactor
    function _swapAndCalculateOpenNotional(InternalSwapParams memory params) internal returns (SwapResponse memory) {
        int256 positionSize = AccountBalance(accountBalance).getPositionSize(params.trader, params.baseToken);
        int256 oldOpenNotional = getOpenNotional(params.trader, params.baseToken);
        int256 deltaAvailableQuote;

        SwapResponse memory response;

        // if increase position (old / new position are in the same direction)
        if (_isIncreasePosition(params.trader, params.baseToken, params.isBaseToQuote)) {
            response = _swap(params);

            // TODO change _swap.response.deltaAvailableQuote to int
            // after swapCallback mint task
            deltaAvailableQuote = params.isBaseToQuote
                ? response.deltaAvailableQuote.toInt256()
                : -response.deltaAvailableQuote.toInt256();

            response.openNotional = getOpenNotional(params.trader, params.baseToken);

            // there is no realizedPnl when increasing position
            return response;
        }

        // else: openReversePosition
        response = _swap(params);

        uint256 positionSizeAbs = positionSize.abs();
        // position size based closedRatio
        uint256 closedRatio = FullMath.mulDiv(response.deltaAvailableBase, 1 ether, positionSizeAbs);

        // TODO change _swap.response.deltaAvailableQuote to int
        deltaAvailableQuote = params.isBaseToQuote
            ? response.deltaAvailableQuote.toInt256()
            : -response.deltaAvailableQuote.toInt256();

        int256 realizedPnl;
        // if reduce or close position (closeRatio <= 1)
        if (positionSizeAbs >= response.deltaAvailableBase) {
            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=148137350
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 10 base (reduce half of the position)
            // deltaAvailableQuote = 137.5
            // closeRatio = 10/20 = 0.5
            // reducedOpenNotional = oldOpenNotional * closedRatio = -252.53 * 0.5 = -126.265
            // realizedPnl = deltaAvailableQuote + reducedOpenNotional = 137.5 + -126.265 = 11.235
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 252.53 - 137.5 + 11.235 = 126.265
            // openNotional = -openNotionalFraction = 126.265
            int256 reducedOpenNotional = oldOpenNotional.mul(closedRatio.toInt256()).divBy10_18();
            realizedPnl = deltaAvailableQuote.add(reducedOpenNotional);
        } else {
            // else, open a larger reverse position

            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=668982944
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 30 base (open a larger reverse position)
            // deltaAvailableQuote = 337.5
            // closeRatio = 30/20 = 1.5
            // closedPositionNotional = deltaAvailableQuote / closeRatio = 337.5 / 1.5 = 225
            // remainsPositionNotional = deltaAvailableQuote - closedPositionNotional = 337.5 - 225 = 112.5
            // realizedPnl = closedPositionNotional + oldOpenNotional = -252.53 + 225 = -27.53
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 252.53 - 337.5 + -27.53 = -112.5
            // openNotional = -openNotionalFraction = remainsPositionNotional = 112.5
            int256 closedPositionNotional = deltaAvailableQuote.mul(1 ether).div(closedRatio.toInt256());
            realizedPnl = oldOpenNotional.add(closedPositionNotional);
        }

        _realizePnl(params.trader, params.baseToken, realizedPnl);
        response.openNotional = getOpenNotional(params.trader, params.baseToken);
        response.realizedPnl = realizedPnl;

        AccountBalance(accountBalance).deregisterBaseToken(params.trader, params.baseToken);

        return response;
    }

    // caller must ensure there's enough quote available and debt
    function _realizePnl(
        address trader,
        address baseToken,
        int256 deltaPnl
    ) internal {
        if (deltaPnl == 0) {
            return;
        }

        // TODO refactor with settle()
        AccountBalance(accountBalance).addOwedRealizedPnl(trader, deltaPnl);
        _addQuote(trader, baseToken, -deltaPnl);
    }

    // check here for custom fee design,
    // https://www.notion.so/perp/Customise-fee-tier-on-B2QFee-1b7244e1db63416c8651e8fa04128cdb
    function _swap(InternalSwapParams memory params) internal returns (SwapResponse memory) {
        Exchange.SwapResponse memory response =
            Exchange(exchange).swap(
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

        // update internal states
        // examples:
        // https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events?node-id=0%3A1
        _addBase(params.trader, params.baseToken, response.exchangedPositionSize);
        _addQuote(params.trader, params.baseToken, response.exchangedPositionNotional.sub(response.fee.toInt256()));
        AccountBalance(accountBalance).addOwedRealizedPnl(insuranceFund, response.insuranceFundFee.toInt256());

        // update timestamp of the first tx in this market
        if (AccountBalance(accountBalance).getFirstTradedTimestamp(params.baseToken) == 0) {
            AccountBalance(accountBalance).updateFirstTradedTimestamp(params.baseToken);
        }

        return
            SwapResponse({
                deltaAvailableBase: response.exchangedPositionSize.abs(),
                deltaAvailableQuote: response.exchangedPositionNotional.sub(response.fee.toInt256()).abs(),
                exchangedPositionSize: response.exchangedPositionSize,
                exchangedPositionNotional: response.exchangedPositionNotional,
                fee: response.fee,
                openNotional: 0,
                realizedPnl: 0,
                tick: response.tick
            });
    }

    function _removeLiquidity(InternalRemoveLiquidityParams memory params)
        private
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
    function _openPosition(InternalOpenPositionParams memory params) internal returns (SwapResponse memory) {
        SwapResponse memory swapResponse =
            _swapAndCalculateOpenNotional(
                InternalSwapParams({
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

        emit PositionChanged(
            params.trader,
            params.baseToken,
            swapResponse.exchangedPositionSize,
            swapResponse.exchangedPositionNotional,
            swapResponse.fee,
            swapResponse.openNotional,
            swapResponse.realizedPnl
        );

        return swapResponse;
    }

    function _closePosition(InternalClosePositionParams memory params) internal returns (SwapResponse memory) {
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
        uint24 partialCloseRatio = ClearingHouseConfig(config).partialCloseRatio();
        if (
            partialCloseRatio > 0 &&
            (_isOverPriceLimit(params.baseToken, Exchange(exchange).getTick(params.baseToken)) ||
                _isOverPriceLimit(params.baseToken, Exchange(exchange).replaySwap(replaySwapParams)))
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
    // INTERNAL VIEW FUNCTIONS
    //

    function _isOverPriceLimit(address baseToken, int24 tick) internal view returns (bool) {
        uint24 maxTickDelta = _maxTickCrossedWithinBlockMap[baseToken];
        if (maxTickDelta == 0) {
            return false;
        }
        int24 lastUpdatedTick = AccountBalance(accountBalance).getLastUpdatedTickMap(baseToken);
        // no overflow/underflow issue because there are range limits for tick and maxTickDelta
        int24 upperTickBound = lastUpdatedTick + int24(maxTickDelta);
        int24 lowerTickBound = lastUpdatedTick - int24(maxTickDelta);
        return (tick < lowerTickBound || tick > upperTickBound);
    }

    function _getSqrtPriceLimit(address baseToken, bool isLong) internal view returns (uint160) {
        int24 lastUpdatedTick = AccountBalance(accountBalance).getLastUpdatedTickMap(baseToken);
        uint24 maxTickDelta = _maxTickCrossedWithinBlockMap[baseToken];
        int24 tickBoundary =
            isLong ? lastUpdatedTick + int24(maxTickDelta) + 1 : lastUpdatedTick - int24(maxTickDelta) - 1;
        return TickMath.getSqrtRatioAtTick(tickBoundary);
    }

    // -------------------------------
    // --- funding related getters ---

    // --- funding related getters ---
    // -------------------------------

    // return decimals 18
    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        uint256 totalDebtValue = AccountBalance(accountBalance).getTotalDebtValue(trader);
        uint256 totalPositionValue = AccountBalance(accountBalance).getTotalAbsPositionValue(trader);
        uint24 imRatio = ClearingHouseConfig(config).imRatio();
        return MathUpgradeable.max(totalPositionValue, totalDebtValue).mulRatio(imRatio);
    }

    // return in settlement token decimals
    function _getTotalCollateralValue(address trader) internal view returns (int256) {
        int256 owedRealizedPnl = AccountBalance(accountBalance).getOwedRealizedPnlWithPendingFundingPayment(trader);
        return IVault(vault).balanceOf(trader).addS(owedRealizedPnl, _settlementTokenDecimals);
    }

    function _hasPool(address baseToken) internal view returns (bool) {
        return Exchange(exchange).getPool(baseToken) != address(0);
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
        require(_hasPool(baseToken), "CH_BTNE");
    }

    // there are three configurations for different insolvency risk tolerance: conservative, moderate, aggressive
    // we will start with the conservative one, then gradually change it to more aggressive ones
    // to increase capital efficiency.
    function _getFreeCollateral(address trader) private view returns (int256) {
        // conservative config: freeCollateral = max(min(collateral, accountValue) - imReq, 0)
        int256 totalCollateralValue = _getTotalCollateralValue(trader);
        int256 totalUnrealizedPnl = AccountBalance(accountBalance).getTotalUnrealizedPnl(trader);
        int256 accountValue = totalCollateralValue.addS(totalUnrealizedPnl, _settlementTokenDecimals);
        uint256 totalInitialMarginRequirement = _getTotalInitialMarginRequirement(trader);
        int256 freeCollateral =
            PerpMath.min(totalCollateralValue, accountValue).subS(
                totalInitialMarginRequirement.toInt256(),
                _settlementTokenDecimals
            );

        return freeCollateral;

        // TODO checklist before enabling more aggressive configs:
        // - protect the system against index price spread attack
        //   https://www.notion.so/perp/Index-price-spread-attack-2f203d45b34f4cc3ab80ac835247030f
        // - protect against index price anomaly (see the TODO for aggressive model below)

        // moderate config: freeCollateral = max(min(collateral, accountValue - imReq), 0)
        // return PerpMath.max(PerpMath.min(collateralValue, accountValue.subS(totalImReq, decimals)), 0).toUint256();

        // aggressive config: freeCollateral = max(accountValue - imReq, 0)
        // TODO note that aggressive model depends entirely on unrealizedPnl, which depends on the index price, for
        //  calculating freeCollateral. We should implement some sort of safety check before using this model;
        //  otherwise a trader could drain the entire vault if the index price deviates significantly.
        // return PerpMath.max(accountValue.subS(totalImReq, decimals), 0).toUint256()
    }

    function _requireEnoughFreeCollateral(address trader) internal view {
        // CH_NEAV: not enough account value
        require(_getFreeCollateral(trader) >= 0, "CH_NEAV");
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

    //
    // TODO: remove after changing to accountBalance
    //
    function _addBase(
        address trader,
        address baseToken,
        int256 delta
    ) internal {
        AccountBalance(accountBalance).addBase(trader, baseToken, delta);
    }

    function _addQuote(
        address trader,
        address baseToken,
        int256 delta
    ) internal {
        AccountBalance(accountBalance).addQuote(trader, baseToken, delta);
    }

    function _getBase(address trader, address baseToken) internal view returns (int256) {
        return AccountBalance(accountBalance).getBase(trader, baseToken);
    }

    function _getQuote(address trader, address baseToken) internal view returns (int256) {
        return AccountBalance(accountBalance).getQuote(trader, baseToken);
    }

    // TODO move vault'starget to accountBALANCE
    function getOwedRealizedPnl(address trader) external view returns (int256) {
        return AccountBalance(accountBalance).getOwedRealizedPnl(trader);
    }

    // TODO remove after fixing test
    function getPendingFundingPayment(address trader, address baseToken) external view returns (int256) {
        return AccountBalance(accountBalance).getPendingFundingPayment(trader, baseToken);
    }

    /// @dev settle() would be called by Vault.withdraw()
    function settle(address trader) external override returns (int256) {
        // only vault
        require(_msgSender() == vault, "CH_OV");
        return AccountBalance(accountBalance).settle(trader);
    }

    function getPositionSize(address trader, address baseToken) external view returns (int256) {
        return AccountBalance(accountBalance).getPositionSize(trader, baseToken);
    }

    function getNetQuoteBalance(address trader) public view returns (int256) {
        return AccountBalance(accountBalance).getNetQuoteBalance(trader);
    }

    function getTotalUnrealizedPnl(address trader) external view returns (int256) {
        return AccountBalance(accountBalance).getTotalUnrealizedPnl(trader);
    }
}
