pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { IMintableERC20 } from "./interface/IMintableERC20.sol";
import { Path } from "@uniswap/v3-periphery/contracts/libraries/Path.sol";

contract ClearingHouse is IUniswapV3MintCallback, IUniswapV3SwapCallback, ReentrancyGuard, Context, Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SafeCast for uint128;
    using SignedSafeMath for int256;
    using SafeCast for int256;
    using Path for bytes;

    //
    // events
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Minted(address indexed token, uint256 amount);
    event Burned(address indexed token, uint256 amount);
    event LiquidityChanged(
        address indexed baseToken,
        address indexed quoteToken,
        int24 lowerTick,
        int24 upperTick,
        int256 base,
        int256 quote,
        int128 liquidity,
        uint256 baseFee,
        uint256 quoteFee
    );

    //
    // Struct
    //

    struct Account {
        uint256 collateral;
        address[] tokens; // all tokens (incl. quote and base) this account is in debt of
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => TokenInfo) tokenInfoMap; // balance & debt info of each token
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => MakerPosition) makerPositionMap; // open orders for maker
    }

    struct TokenInfo {
        uint256 available; // amount available in CH
        uint256 debt;
        uint256 owedFee;
    }

    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideLastBase;
        uint256 feeGrowthInsideLastQuote;
    }

    struct MakerPosition {
        bytes32[] orderIds;
        // key: order id
        mapping(bytes32 => OpenOrder) openOrderMap;
    }

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
    }

    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct SwapParams {
        address baseToken;
        address quoteToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    //
    // state variables
    //
    uint256 public imRatio = 0.1 ether; // initial-margin ratio, 10%
    uint256 public mmRatio = 0.0625 ether; // minimum-margin ratio, 6.25%

    address public immutable collateralToken;
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;

    // key: base token, value: pool
    mapping(address => address) private _poolMap;

    // key: trader
    mapping(address => Account) private _accountMap;

    constructor(
        address collateralTokenArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) {
        require(collateralTokenArg != address(0), "CH_II_C");
        require(quoteTokenArg != address(0), "CH_II_Q");
        require(uniV3FactoryArg != address(0), "CH_II_U");

        collateralToken = collateralTokenArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        // to ensure the base is always token0 and quote is always token1
        // CH_IB: invalid baseToken
        require(baseToken < quoteToken, "CH_IB");
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(pool != _poolMap[baseToken], "CH_EP");

        _poolMap[baseToken] = pool;
        emit PoolAdded(baseToken, feeRatio, pool);
    }

    // TODO should add modifier: whenNotPaused()
    function deposit(uint256 amount) external nonReentrant() {
        address trader = _msgSender();
        Account storage account = _accountMap[trader];
        account.collateral = account.collateral.add(amount);
        TransferHelper.safeTransferFrom(collateralToken, trader, address(this), amount);

        emit Deposited(collateralToken, trader, amount);
    }

    // TODO: WIP be blocked by swap()
    function burn(address token, uint256 amount) external nonReentrant() {
        _requireTokenExistAndValidAmount(token, amount);

        // update internal states
        address trader = _msgSender();
        TokenInfo storage tokenInfo = _accountMap[trader].tokenInfoMap[token];
        tokenInfo.available = tokenInfo.available.sub(amount);
        tokenInfo.debt = tokenInfo.debt.sub(amount);

        emit Burned(token, amount);
    }

    function swap(SwapParams memory params) external nonReentrant() returns (UniswapV3Broker.SwapResponse memory) {
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[params.baseToken]);
        return
            UniswapV3Broker.swap(
                UniswapV3Broker.SwapParams(
                    pool,
                    params.baseToken,
                    params.quoteToken,
                    params.isBaseToQuote,
                    params.isExactInput,
                    params.amount,
                    params.sqrtPriceLimitX96
                )
            );
    }

    // TODO should add modifier: whenNotPaused()
    function mint(address token, uint256 amount) external nonReentrant() {
        _requireTokenExistAndValidAmount(token, amount);

        IMintableERC20(token).mint(address(this), amount);

        // update internal states
        address trader = _msgSender();
        TokenInfo storage tokenInfo = _accountMap[trader].tokenInfoMap[token];
        tokenInfo.available = tokenInfo.available.add(amount);
        tokenInfo.debt = tokenInfo.debt.add(amount);

        _registerToken(trader, token);

        // TODO: optimize when mint both
        // CH_NEAV: not enough account value
        require(getAccountValue(trader) >= _getTotalInitialMarginRequirement(trader).toInt256(), "CH_NEAV");

        emit Minted(token, amount);
    }

    function addLiquidity(AddLiquidityParams calldata params) external nonReentrant() {
        address trader = _msgSender();
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        uint256 baseAvailable = baseTokenInfo.available;
        uint256 quoteAvailable = quoteTokenInfo.available;
        // CH_NEB: not enough available base amount
        require(baseAvailable >= params.base, "CH_NEB");
        // CH_NEB: not enough available quote amount
        require(quoteAvailable >= params.quote, "CH_NEQ");

        // add liquidity to liquidity pool
        UniswapV3Broker.MintResponse memory response =
            UniswapV3Broker.mint(
                UniswapV3Broker.MintParams(
                    _poolMap[params.baseToken],
                    params.baseToken,
                    quoteToken,
                    params.lowerTick,
                    params.upperTick,
                    params.base,
                    params.quote
                )
            );

        // TODO add slippage protection

        // load existing open order
        bytes32 orderId = _getOrderId(trader, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];
        if (openOrder.liquidity == 0) {
            openOrder.lowerTick = params.lowerTick;
            openOrder.upperTick = params.upperTick;
        } else {
            // update token info based on existing open order
            baseTokenInfo.owedFee = baseTokenInfo.owedFee.add(
                _calcOwnedFee(openOrder.liquidity, response.feeGrowthInsideLastBase, openOrder.feeGrowthInsideLastBase)
            );
            quoteTokenInfo.owedFee = quoteTokenInfo.owedFee.add(
                _calcOwnedFee(
                    openOrder.liquidity,
                    response.feeGrowthInsideLastQuote,
                    openOrder.feeGrowthInsideLastQuote
                )
            );
        }

        // update token info
        baseTokenInfo.available = baseAvailable.sub(response.base);
        quoteTokenInfo.available = quoteAvailable.sub(response.quote);

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().add(response.liquidity.toUint256()).toUint128();
        openOrder.feeGrowthInsideLastBase = response.feeGrowthInsideLastBase;
        openOrder.feeGrowthInsideLastQuote = response.feeGrowthInsideLastQuote;

        _emitLiquidityChanged(trader, params, response);
    }

    function removeLiquidity(RemoveLiquidityParams calldata params) external nonReentrant() {
        // load existing open order
        address trader = _msgSender();
        bytes32 orderId = _getOrderId(trader, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];
        uint128 previousLiquidity = openOrder.liquidity;

        // CH_ZL zero liquidity
        require(previousLiquidity > 0, "CH_ZL");
        // CH_NEL not enough liquidity
        require(params.liquidity <= previousLiquidity, "CH_NEL");

        UniswapV3Broker.BurnResponse memory response =
            UniswapV3Broker.burn(
                UniswapV3Broker.BurnParams(
                    _poolMap[params.baseToken],
                    params.lowerTick,
                    params.upperTick,
                    params.liquidity
                )
            );

        // TODO add slippage protection

        // update token info based on existing open order
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        baseTokenInfo.owedFee = baseTokenInfo.owedFee.add(
            _calcOwnedFee(previousLiquidity, response.feeGrowthInsideLastBase, openOrder.feeGrowthInsideLastBase)
        );
        quoteTokenInfo.owedFee = quoteTokenInfo.owedFee.add(
            _calcOwnedFee(previousLiquidity, response.feeGrowthInsideLastQuote, openOrder.feeGrowthInsideLastQuote)
        );
        baseTokenInfo.available = baseTokenInfo.available.add(response.base);
        quoteTokenInfo.available = quoteTokenInfo.available.add(response.quote);

        // update open order with new liquidity
        openOrder.liquidity = previousLiquidity.toUint256().sub(params.liquidity.toUint256()).toUint128();
        if (openOrder.liquidity == 0) {
            delete _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];
        } else {
            openOrder.feeGrowthInsideLastBase = response.feeGrowthInsideLastBase;
            openOrder.feeGrowthInsideLastQuote = response.feeGrowthInsideLastQuote;
        }

        _emitLiquidityChanged(trader, params, response);
    }

    // @audit: review security and possible attacks (@detoo)
    // @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data // contains baseToken
    ) external override {
        address baseToken = abi.decode(data, (address));
        address pool = _poolMap[baseToken];
        // CH_FMV: failed mintCallback verification
        require(_msgSender() == pool, "CH_FMV");

        if (amount0Owed > 0) {
            IMintableERC20(IUniswapV3Pool(pool).token0()).transfer(pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            IMintableERC20(IUniswapV3Pool(pool).token1()).transfer(pool, amount1Owed);
        }
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_ZIs: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        address baseToken = abi.decode(data, (address));
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[baseToken]);
        // CH_FSV: failed swapCallback verification
        require(_msgSender() == address(pool), "CH_FSV");

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0 ? (pool.token0(), uint256(amount0Delta)) : (pool.token1(), uint256(amount1Delta));
        IMintableERC20(token).transfer(_msgSender(), amountToPay);
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getPool(address baseToken) external view returns (address) {
        return _poolMap[baseToken];
    }

    function getCollateral(address trader) external view returns (uint256) {
        return _accountMap[trader].collateral;
    }

    function getAccountValue(address trader) public view returns (int256) {
        return _accountMap[trader].collateral.toInt256().add(_getTotalMarketPnl(trader));
    }

    function getAccountTokens(address trader) public view returns (address[] memory) {
        return _accountMap[trader].tokens;
    }

    function getFreeCollateral(address trader) public view returns (uint256) {
        int256 freeCollateral = getAccountValue(trader).sub(_getTotalInitialMarginRequirement(trader).toInt256());
        return freeCollateral > 0 ? freeCollateral.toUint256() : 0;
    }

    function getIndexPrice(address token) public view returns (uint256) {
        // TODO WIP
        return 100 ether;
    }

    function getTokenInfo(address trader, address token) external view returns (TokenInfo memory) {
        return _accountMap[trader].tokenInfoMap[token];
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder memory) {
        return
            _accountMap[trader].makerPositionMap[baseToken].openOrderMap[
                _getOrderId(trader, baseToken, lowerTick, upperTick)
            ];
    }

    //
    // INTERNAL FUNCTIONS
    //
    function _registerToken(address trader, address token) private {
        address[] memory tokens = _accountMap[trader].tokens;
        if (tokens.length == 0) {
            _accountMap[trader].tokens.push(token);
        } else {
            bool hit;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == token) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                _accountMap[trader].tokens.push(token);
            }
        }
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //
    function _getTotalMarketPnl(address trader) internal pure returns (int256) {
        return 0; // TODO WIP
    }

    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        Account storage account = _accountMap[trader];

        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = account.tokenInfoMap[quoteToken].debt;
        uint256 totalPositionValue;
        uint256 totalBaseDebtValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_isPoolExistent(baseToken)) {
                uint256 baseDebtValue = _getDebtValue(baseToken, account.tokenInfoMap[baseToken].debt);
                uint256 positionValue = _getPositionValue(account, baseToken);
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
                totalPositionValue = totalPositionValue.add(positionValue);
            }
        }

        return Math.max(totalPositionValue, Math.max(totalBaseDebtValue, quoteDebtValue)).mul(imRatio).div(1 ether);
    }

    function _getDebtValue(address token, uint256 amount) private view returns (uint256) {
        return amount.mul(getIndexPrice(token)).div(1 ether);
    }

    function _getPositionValue(Account storage account, address baseToken) private view returns (uint256) {
        // TODO WIP
        // uint256 positionSize = _getPositionSize(account, baseToken);
        // simulate trade and calculate position value
        // positionValue = getExactBastToQuote(pool, 1)
        return 0;
    }

    function _isPoolExistent(address baseToken) internal view returns (bool) {
        return _poolMap[baseToken] != address(0);
    }

    function _getOrderId(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(address(trader), address(baseToken), lowerTick, upperTick));
    }

    function _calcOwnedFee(
        uint128 liquidity,
        uint256 feeGrowthInsideLastNew,
        uint256 feeGrowthInsideLastOld
    ) private pure returns (uint256) {
        return liquidity.toUint256().mul(feeGrowthInsideLastNew.sub(feeGrowthInsideLastOld));
    }

    function _emitLiquidityChanged(
        address trader,
        RemoveLiquidityParams memory params,
        UniswapV3Broker.BurnResponse memory response
    ) private {
        emit LiquidityChanged(
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            -response.base.toInt256(),
            -response.quote.toInt256(),
            -params.liquidity.toInt128(),
            _accountMap[trader].tokenInfoMap[params.baseToken].owedFee,
            _accountMap[trader].tokenInfoMap[quoteToken].owedFee
        );
    }

    function _emitLiquidityChanged(
        address trader,
        AddLiquidityParams memory params,
        UniswapV3Broker.MintResponse memory response
    ) private {
        emit LiquidityChanged(
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.liquidity.toInt128(),
            _accountMap[trader].tokenInfoMap[params.baseToken].owedFee,
            _accountMap[trader].tokenInfoMap[quoteToken].owedFee
        );
    }

    function _requireTokenExistAndValidAmount(address token, uint256 amount) private view {
        if (quoteToken != token) {
            // CH_TNF: token not found
            require(_isPoolExistent(token), "CH_TNF");
        }
        // CH_IA: invalid amount
        require(amount > 0, "CH_IA");
    }
}
