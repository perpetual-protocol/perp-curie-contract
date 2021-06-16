pragma solidity 0.7.6;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";

contract ClearingHouse is ReentrancyGuard, Context, Ownable {
    using SafeMath for uint256;
    using SignedSafeMath for int256;
    //
    // events
    //
    event PoolAdded(address indexed base, uint24 indexed feeRatio, address indexed pool);
    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);

    //
    // Struct
    //
    struct Account {
        uint256 collateral;
        // key: vToken
        mapping(address => Asset) asset;
    }

    struct Asset {
        uint256 available; // amount available in CH
        uint256 debt;
    }

    //
    // state variables
    //
    address public immutable collateralToken;
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;

    mapping(address => bool) private _poolMap;

    mapping(address => uint256) private _collateral;

    constructor(
        address collateralTokenArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) {
        collateralToken = collateralTokenArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(!_poolMap[address(pool)], "CH_EP");

        // update poolMap
        _poolMap[pool] = true;

        emit PoolAdded(baseToken, feeRatio, pool);
    }

    // TODO should add modifier: whenNotPaused()
    function deposit(uint256 amount) external nonReentrant() {
        address trader = _msgSender();
        _collateral[trader] = _collateral[trader].add(amount);
        TransferHelper.safeTransferFrom(collateralToken, trader, address(this), amount);

        emit Deposited(collateralToken, trader, amount);
    }

    // TODO should add modifier: whenNotPaused()
    function mint(
        address baseToken,
        uint256 base,
        uint256 quote
    ) external nonReentrant() {
        Account account = _account[_msgSender()];

        // mint vTokens
        IERC20(baseToken).mint(base);
        IERC20(quoteToken).mint(quote);

        // update states
        Asset baseAsset = account.asset[baseToken];
        Asset quoteAsset = account.asset[quoteToken];

        asset.baseAsset.available += base;
        asset.baseAsset.debt += base;
        asset.quoteAsset.available += quote;
        asset.quoteAsset.debt += quote;

        require(freeCollateral(msg.sender) > 0);
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function isPoolExisted(address pool) external view returns (bool) {
        return _poolMap[pool];
    }

    function getCollateral(address trader) external view returns (uint256) {
        return _collateral[trader];
    }

    function getAccountValue(address trader) public view returns (int256) {
        return int256(_collateral[trader]).add(getTotalMarketPnl(trader));
    }

    function getFreeCollateral(address trader) external view returns (uint256) {
        int256 freeCollateral = getAccountValue(trader).sub(int256(getTotalInitialMarginRequirement(trader)));
        return freeCollateral > 0 ? uint256(freeCollateral) : 0;
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //
    function getTotalMarketPnl(address trader) internal pure returns (int256) {
        return 0; // TODO WIP
    }

    function getTotalInitialMarginRequirement(address trader) internal pure returns (uint256) {
        return 0; // TODO WIP
    }
}
